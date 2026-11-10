//! Integration tests on synthetic session files in a temp dir. Real-file equivalence against pi's
//! own reader lives in tools/verify-host-sessions.mjs.
use pegasus_core::index::{parse_iso_ms, scan_file, Index};
use pegasus_core::rpc::Server;
use pegasus_core::session;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pegasus-core-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

const HEADER: &str = r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-10-28T09:09:03.836Z","cwd":"D:\\p"}"#;
fn user(id: &str, parent: &str, text: &str) -> String {
    format!(r#"{{"type":"message","id":"{id}","parentId":{parent},"timestamp":"2026-10-28T09:10:00.000Z","message":{{"role":"user","content":"{text}","timestamp":1793178600000}}}}"#)
}
fn assistant(id: &str, parent: &str) -> String {
    format!(r#"{{"type":"message","id":"{id}","parentId":"{parent}","timestamp":"2026-10-28T09:11:00.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"a"}},{{"type":"text","text":"b"}}]}}}}"#)
}
fn write(p: &Path, lines: &[String]) {
    fs::write(p, lines.join("\n") + "\n").unwrap();
}
fn snapshot(p: &Path) -> (Vec<u8>, std::time::SystemTime) {
    (fs::read(p).unwrap(), fs::metadata(p).unwrap().modified().unwrap())
}

#[test]
fn iso_parse_matches_js_date() {
    assert_eq!(parse_iso_ms("2026-10-28T09:09:03.836Z"), Some(1793178543836.0));
    assert_eq!(parse_iso_ms("2026-10-28T11:09:03+02:00"), Some(1793178543000.0));
    assert_eq!(parse_iso_ms("1969-12-31T23:59:59.5Z"), Some(-500.0));
    assert_eq!(parse_iso_ms("not a date"), None);
}

#[test]
fn index_counts_names_and_resumes_after_append() {
    let d = tmp("index");
    let f = d.join("a.jsonl");
    let name = r#"{"type":"session_info","id":"n","parentId":null,"name":"  My chat "}"#.to_string();
    write(&f, &[HEADER.into(), name, user("u1", "null", "hello"), assistant("a1", "u1")]);
    let one = scan_file(&f, None).unwrap();
    assert_eq!((one.message_count, one.first_message.as_str(), one.name.as_deref()), (2, "hello", Some("My chat")));
    assert_eq!(one.last_activity_ms, Some(1793178660000.0));

    // Append: the resumed scan must equal a from-scratch scan, and start past the old offset.
    let before = one.scanned_to;
    fs::OpenOptions::new().append(true).open(&f).unwrap().write_all((user("u2", "\"a1\"", "again") + "\n").as_bytes()).unwrap();
    let resumed = scan_file(&f, Some(&one)).unwrap();
    let fresh = scan_file(&f, None).unwrap();
    assert!(resumed.scanned_to > before);
    assert_eq!((resumed.message_count, resumed.last_activity_ms, &resumed.first_message), (fresh.message_count, fresh.last_activity_ms, &fresh.first_message));
    assert_eq!(resumed.message_count, 3);

    // Rewritten (not appended) file with a different header: full rescan, not a bogus resume.
    write(&f, &[HEADER.replace("s1", "s2"), user("u1", "null", "x")]);
    let rewritten = scan_file(&f, Some(&resumed)).unwrap();
    assert_eq!((rewritten.id.as_str(), rewritten.message_count), ("s2", 1));
    // Not a session at all.
    fs::write(d.join("b.jsonl"), "{\"type\":\"message\"}\n").unwrap();
    assert!(scan_file(&d.join("b.jsonl"), None).is_none());
}

#[test]
fn list_dir_sorts_newest_first_and_persists_cache() {
    let d = tmp("list");
    write(&d.join("old.jsonl"), &[HEADER.into(), user("u", "null", "old")]);
    write(&d.join("new.jsonl"), &[HEADER.replace("s1", "s2"), user("u", "null", "new").replace("1793178600000", "1893178600000")]);
    let cache = d.join("cache.json");
    let idx = Index::new(Some(cache.clone()));
    let l = idx.list_dir(&d);
    assert_eq!(l.iter().map(|s| s.first_message.as_str()).collect::<Vec<_>>(), ["new", "old"]);
    assert!(cache.exists());
    let again = Index::new(Some(cache)).list_dir(&d);
    assert_eq!(again.len(), 2);
}

#[test]
fn context_follows_leaf_branch_and_compaction() {
    let d = tmp("ctx");
    let f = d.join("c.jsonl");
    let compaction = r#"{"type":"compaction","id":"c1","parentId":"a2","timestamp":"2026-10-28T09:12:00.000Z","summary":"s","firstKeptEntryId":"u2","tokensBefore":1}"#;
    // u1 a1 u2 a2 compaction(first kept u2) u3 ; plus a dead branch b1 off u1 that is not on the leaf path.
    write(&f, &[
        HEADER.into(),
        user("u1", "null", "1"), assistant("a1", "u1"),
        user("b1", "\"u1\"", "dead branch"),
        user("u2", "\"a1\"", "2"), assistant("a2", "u2"),
        compaction.into(),
        user("u3", "\"c1\"", "3"),
    ]);
    let c = session::context(&f, "pi-gui.pin").unwrap();
    let ids: Vec<String> = c.entries.iter().map(|r| {
        let v: serde_json::Value = serde_json::from_slice(&c.bytes[r.clone()]).unwrap();
        v["id"].as_str().unwrap().to_string()
    }).collect();
    assert_eq!(ids, ["c1", "u2", "a2", "u3"]);

    // No compaction: whole branch, dead branch excluded.
    write(&f, &[HEADER.into(), user("u1", "null", "1"), assistant("a1", "u1"), user("b1", "\"u1\"", "x")]);
    let c = session::context(&f, "pi-gui.pin").unwrap();
    assert_eq!(c.entries.len(), 2); // leaf is b1 -> u1 -> b1
}

#[test]
fn old_schema_is_refused_so_the_caller_falls_back() {
    let d = tmp("v2");
    let f = d.join("o.jsonl");
    write(&f, &[HEADER.replace("\"version\":3", "\"version\":2"), user("u1", "null", "1")]);
    assert_eq!(session::context(&f, "x").err().as_deref(), Some("unsupported_version"));
}

#[test]
fn tail_returns_only_complete_new_lines() {
    let d = tmp("tail");
    let f = d.join("t.jsonl");
    write(&f, &[HEADER.into(), user("u1", "null", "1")]);
    let start = session::end_offset(&f).unwrap();
    assert_eq!(start, fs::metadata(&f).unwrap().len());
    // One whole line plus half of another.
    let mut h = fs::OpenOptions::new().append(true).open(&f).unwrap();
    h.write_all((assistant("a1", "u1") + "\n" + "{\"type\":\"mess").as_bytes()).unwrap();
    let t = session::tail(&f, start).unwrap();
    assert_eq!(t.lines.len(), 1);
    assert!(!t.reset);
    // The half line completes later and is then delivered from the stored offset.
    h.write_all(b"age\"}\n").unwrap();
    let t2 = session::tail(&f, t.offset).unwrap();
    assert_eq!(t2.lines, vec![br#"{"type":"message"}"#.to_vec()]);
    // File shrank: caller must reload.
    write(&f, &[HEADER.into()]);
    assert!(session::tail(&f, t2.offset).unwrap().reset);
}

/// Mirrors the host envelope: `{"result":..}` or `{"error":{"code":..}}`.
fn call(s: &mut Server, v: serde_json::Value) -> serde_json::Value {
    match s.call(v["method"].as_str().unwrap(), &v["params"]) {
        Ok(body) => serde_json::json!({ "result": serde_json::from_slice::<serde_json::Value>(&body).unwrap() }),
        Err((code, message)) => serde_json::json!({ "error": { "code": code, "message": message } }),
    }
}

#[test]
fn rpc_confines_paths_to_the_sessions_root() {
    let root = tmp("rpc");
    let inside = root.join("proj");
    fs::create_dir_all(&inside).unwrap();
    write(&inside.join("a.jsonl"), &[HEADER.into(), user("u1", "null", "1")]);
    let outside = tmp("rpc-outside");
    write(&outside.join("secret.jsonl"), &[HEADER.into()]);
    fs::write(outside.join("notes.txt"), "x").unwrap();
    let mut s = Server::new(&root, None).unwrap();
    let ok = |v: &serde_json::Value| v.get("result").is_some();
    let code = |v: &serde_json::Value| v["error"]["code"].as_str().unwrap_or("").to_string();

    let path = inside.join("a.jsonl").to_string_lossy().to_string();
    assert!(ok(&call(&mut s, serde_json::json!({"v":1,"id":1,"method":"session.context","params":{"path":path,"pinType":"p"}}))));

    // Absolute path outside, dot-dot escape, non-jsonl, directory, NUL byte, unknown field, bad version.
    let esc = format!("{}/../../{}/secret.jsonl", inside.display(), outside.file_name().unwrap().to_string_lossy());
    for p in [outside.join("secret.jsonl").to_string_lossy().to_string(), esc, outside.join("notes.txt").to_string_lossy().to_string(), "a\0b".to_string()] {
        let r = call(&mut s, serde_json::json!({"v":1,"id":2,"method":"session.context","params":{"path":p,"pinType":"p"}}));
        assert!(!ok(&r), "must reject {p:?}");
    }
    let r = call(&mut s, serde_json::json!({"v":1,"id":3,"method":"index.list","params":{"dir":outside.to_string_lossy()}}));
    assert_eq!(code(&r), "outside_root");
    let r = call(&mut s, serde_json::json!({"v":1,"id":4,"method":"session.context","params":{"path":path,"pinType":"p","extra":1}}));
    assert_eq!(code(&r), "bad_params");
    let r = call(&mut s, serde_json::json!({"v":1,"id":6,"method":"rm -rf"}));
    assert_eq!(code(&r), "unknown_method");
}

#[test]
fn nothing_here_writes_the_session_file() {
    let root = tmp("ro");
    let dir = root.join("p");
    fs::create_dir_all(&dir).unwrap();
    let f = dir.join("a.jsonl");
    write(&f, &[HEADER.into(), user("u1", "null", "1"), assistant("a1", "u1")]);
    let before = snapshot(&f);
    let mut s = Server::new(&root, Some(root.join("cache.json"))).unwrap();
    let path = f.to_string_lossy().to_string();
    let dirs = dir.to_string_lossy().to_string();
    for req in [
        serde_json::json!({"v":1,"id":1,"method":"index.list","params":{"dir":dirs}}),
        serde_json::json!({"v":1,"id":2,"method":"session.context","params":{"path":path,"pinType":"p"}}),
        serde_json::json!({"v":1,"id":3,"method":"session.slice","params":{"path":path,"pinType":"p","start":0,"count":5}}),
        serde_json::json!({"v":1,"id":4,"method":"session.tail","params":{"path":path}}),
    ] {
        assert!(call(&mut s, req).get("result").is_some());
    }
    assert_eq!(snapshot(&f), before);
}

#[test]
fn results_match_the_typed_protocol() {
    use pegasus_core::protocol::{SessionContext, SessionList, SessionSlice, SessionTail};
    let root = tmp("typed");
    let dir = root.join("p");
    fs::create_dir_all(&dir).unwrap();
    let f = dir.join("a.jsonl");
    write(&f, &[HEADER.into(), user("u1", "null", "1"), assistant("a1", "u1")]);
    let mut s = Server::new(&root, None).unwrap();
    let path = f.to_string_lossy().to_string();
    let get = |s: &mut Server, m: &str, p: serde_json::Value| s.call(m, &p).unwrap();
    let l: SessionList = serde_json::from_slice(&get(&mut s, "index.list", serde_json::json!({"dir": dir.to_string_lossy()}))).unwrap();
    assert_eq!(l.sessions.len(), 1);
    let c: SessionContext = serde_json::from_slice(&get(&mut s, "session.context", serde_json::json!({"path": path, "pinType": "p"}))).unwrap();
    assert_eq!(c.total as usize, c.entries.len());
    let sl: SessionSlice = serde_json::from_slice(&get(&mut s, "session.slice", serde_json::json!({"path": path, "pinType": "p", "start": 0, "count": 1}))).unwrap();
    assert_eq!(sl.entries.len(), 1);
    let t: SessionTail = serde_json::from_slice(&get(&mut s, "session.tail", serde_json::json!({"path": path, "from": 0}))).unwrap();
    assert_eq!(t.lines.len(), 3);
}
