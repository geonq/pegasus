//! Spawns the real binary on a private endpoint and talks the wire protocol to it.
use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

fn endpoint(tag: &str) -> String {
    let id = format!("{tag}-{}", std::process::id());
    if cfg!(windows) { format!(r"\\.\pipe\pegasus-host-test-{id}") } else { std::env::temp_dir().join(format!("ph-{id}.sock")).to_string_lossy().into() }
}

/// Kills the host if a test fails midway, so no orphan keeps the test's pipes open.
struct Proc(Child);
impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}
impl std::ops::Deref for Proc {
    type Target = Child;
    fn deref(&self) -> &Child { &self.0 }
}
impl std::ops::DerefMut for Proc {
    fn deref_mut(&mut self) -> &mut Child { &mut self.0 }
}

fn spawn(ep: &str, root: &std::path::Path, idle: u64) -> Proc {
    Proc(Command::new(env!("CARGO_BIN_EXE_pegasus-host"))
        .args(["--endpoint", ep, "--sessions-root"]).arg(root)
        .args(["--idle-exit-secs", &idle.to_string()])
        .arg("--log-dir").arg(root.join("logs"))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().unwrap())
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

async fn connect(ep: &str) -> Box<dyn Io> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        #[cfg(windows)]
        let r = tokio::net::windows::named_pipe::ClientOptions::new().open(ep).map(|c| Box::new(c) as Box<dyn Io>);
        #[cfg(unix)]
        let r = tokio::net::UnixStream::connect(ep).await.map(|c| Box::new(c) as Box<dyn Io>);
        match r {
            Ok(c) => return c,
            Err(e) if Instant::now() > deadline => panic!("connect {ep}: {e}"),
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

async fn send(c: &mut Box<dyn Io>, v: Value) {
    let b = v.to_string().into_bytes();
    c.write_all(&(b.len() as u32).to_be_bytes()).await.unwrap();
    c.write_all(&b).await.unwrap();
}

async fn recv(c: &mut Box<dyn Io>) -> Value {
    let mut len = [0u8; 4];
    c.read_exact(&mut len).await.unwrap();
    let mut b = vec![0u8; u32::from_be_bytes(len) as usize];
    c.read_exact(&mut b).await.unwrap();
    serde_json::from_slice(&b).unwrap()
}

async fn call(c: &mut Box<dyn Io>, id: u64, method: &str, params: Value) -> Value {
    send(c, json!({"v":2,"id":id,"method":method,"params":params})).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let v = tokio::time::timeout(left, recv(c)).await.unwrap_or_else(|_| panic!("{method} #{id}: no reply in 20 s"));
        if v["id"] == id { return v; }
    }
}

fn wait_exit(child: &mut Child, secs: u64) -> Option<i32> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if let Some(s) = child.try_wait().unwrap() { return s.code(); }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_handshake_errors_and_shutdown() {
    let root = std::env::temp_dir().join(format!("pegasus-host-root-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("life");
    let mut host = spawn(&ep, &root, 600);
    let mut c = connect(&ep).await;

    let hello = call(&mut c, 1, "hello", json!({"client":"test","appVersion":"0.0.0"})).await;
    assert_eq!(hello["result"]["protocol"], 2, "{hello}");
    assert_eq!(hello["result"]["pid"], host.id());

    // A second host on the same endpoint refuses to start (exit 3) and the first keeps serving.
    let mut second = spawn(&ep, &root, 600);
    assert_eq!(wait_exit(&mut second, 10), Some(3));
    let st = call(&mut c, 2, "status", json!({})).await;
    assert_eq!(st["result"]["clients"], 1, "{st}");

    // Typed errors.
    assert_eq!(call(&mut c, 3, "nope", json!({})).await["error"]["code"], "unknown_method");
    assert_eq!(call(&mut c, 4, "status", json!({"x":1})).await["error"]["code"], "bad_params");
    send(&mut c, json!({"v":1,"id":5,"method":"status"})).await;
    assert_eq!(recv(&mut c).await["error"]["code"], "unsupported_protocol");
    assert_eq!(call(&mut c, 6, "index.list", json!({})).await["result"]["sessions"], json!([]));

    // Shutdown: reply, then a shuttingDown event, then the process exits 0.
    let sd = call(&mut c, 7, "shutdown", json!({"reason":"test"})).await;
    assert_eq!(sd["result"]["accepted"], true);
    let ev = recv(&mut c).await;
    assert_eq!(ev["event"], "shuttingDown", "{ev}");
    assert_eq!(wait_exit(&mut host, 10), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn exits_when_idle_without_clients() {
    let root = std::env::temp_dir().join(format!("pegasus-host-idle-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("idle");
    let mut host = spawn(&ep, &root, 1);
    {
        let mut c = connect(&ep).await;
        call(&mut c, 1, "hello", json!({"client":"test","appVersion":"0.0.0"})).await;
        // While connected it stays up past the idle window.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(host.try_wait().unwrap().is_none(), "host exited while a client was attached");
    }
    assert_eq!(wait_exit(&mut host, 15), Some(0));
}

fn shell() -> (String, Vec<String>) {
    if cfg!(windows) { ("cmd.exe".into(), vec!["/Q".into(), "/K".into()]) } else { ("/bin/sh".into(), vec![]) }
}

fn env_now() -> serde_json::Map<String, Value> {
    std::env::vars().map(|(k, v)| (k, Value::String(v))).collect()
}

/// Reads frames until `pred` matches one, collecting terminal output on the way.
async fn until(c: &mut Box<dyn Io>, out: &mut String, secs: u64, pred: impl Fn(&Value, &str) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let v = tokio::time::timeout(left, recv(c)).await.unwrap_or_else(|_| panic!("timed out; output so far: {out:?}"));
        if std::env::var("HOST_TEST_TRACE").is_ok() { eprintln!("frame {v}"); }
        if v["event"] == "terminalData" { out.push_str(v["data"]["data"].as_str().unwrap_or("")); }
        if pred(&v, out) { return v; }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn terminals_run_replay_survive_reconnect_and_block_soft_shutdown() {
    let root = std::env::temp_dir().join(format!("pegasus-host-term-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("term");
    let mut host = spawn(&ep, &root, 600);
    let mut c = connect(&ep).await;
    let (sh, args) = shell();
    let r = call(&mut c, 1, "terminal.spawn", json!({
        "id": "t1", "shell": sh, "args": args, "cwd": root.to_string_lossy(), "env": env_now(),
        "cols": 100, "rows": 30, "tag": "{\"workspace\":\"w\"}"
    })).await;
    assert_eq!(r["result"]["info"]["status"], "running", "{r}");
    assert!(r["result"]["info"]["pid"].as_u64().is_some());

    send(&mut c, json!({"v":2,"id":2,"method":"terminal.write","params":{"id":"t1","data":"echo pegasus-marker-1\r"}})).await;
    let mut out = String::new();
    until(&mut c, &mut out, 15, |_, o| o.matches("pegasus-marker-1").count() >= 2).await;

    // Running terminal = active work: soft shutdown refused, host stays.
    let sd = call(&mut c, 3, "shutdown", json!({"reason":"soft"})).await;
    assert_eq!(sd["result"]["accepted"], false, "{sd}");
    assert_eq!(sd["result"]["activeWork"], 1);

    // The client goes away; the terminal keeps running. A new client adopts it with replay.
    drop(c);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut c2 = connect(&ep).await;
    let list = call(&mut c2, 1, "terminal.list", json!({})).await;
    assert_eq!(list["result"]["terminals"][0]["tag"], "{\"workspace\":\"w\"}");
    let snap = call(&mut c2, 2, "terminal.attach", json!({"id":"t1"})).await;
    assert!(snap["result"]["replay"].as_str().unwrap().contains("pegasus-marker-1"));
    send(&mut c2, json!({"v":2,"id":3,"method":"terminal.write","params":{"id":"t1","data":"echo pegasus-marker-2\r"}})).await;
    let mut out2 = String::new();
    until(&mut c2, &mut out2, 15, |_, o| o.matches("pegasus-marker-2").count() >= 2).await;

    // Typed errors.
    let dup = call(&mut c2, 4, "terminal.spawn", json!({"id":"t1","shell":"x","cwd":".","env":{},"cols":80,"rows":24,"tag":""})).await;
    assert_eq!(dup["error"]["code"], "already_exists");
    let bad = call(&mut c2, 5, "terminal.spawn", json!({"id":"t2","shell":"definitely-not-a-shell-xyz","cwd":root.to_string_lossy(),"env":{},"cols":80,"rows":24,"tag":""})).await;
    assert_eq!(bad["error"]["code"], "spawn_failed", "{bad}");
    assert_eq!(call(&mut c2, 6, "terminal.write", json!({"id":"nope","data":"x"})).await["error"]["code"], "not_found");

    // Exit is reported, then kill forgets it.
    send(&mut c2, json!({"v":2,"id":7,"method":"terminal.write","params":{"id":"t1","data":"exit 7\r"}})).await;
    let ex = until(&mut c2, &mut out2, 15, |v, _| v["event"] == "terminalExit").await;
    assert_eq!(ex["data"]["exitCode"], 7, "{ex}");
    assert_eq!(call(&mut c2, 8, "terminal.kill", json!({"id":"t1"})).await["result"], json!({}));
    assert_eq!(call(&mut c2, 9, "terminal.list", json!({})).await["result"]["terminals"], json!([]));

    assert_eq!(call(&mut c2, 10, "shutdown", json!({"reason":"done"})).await["result"]["accepted"], true);
    assert_eq!(wait_exit(&mut host, 10), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn detached_host_holds_no_launcher_pipes_and_reaps_orphaned_terminals() {
    let root = std::env::temp_dir().join(format!("pegasus-host-detach-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("detach");
    // The launcher's stdout is a pipe we read to EOF: it must close as soon as the launcher exits,
    // even though the host it started keeps running. Had the host held the pipes, output() would
    // return only once the host idled out (2 s), and the connect below would find no host. That is
    // the proof; a wall-clock bound was not, since parallel tests slow a healthy launch past it.
    let out = Command::new(env!("CARGO_BIN_EXE_pegasus-host"))
        .args(["--detach", "--endpoint", &ep, "--sessions-root"]).arg(&root)
        .args(["--idle-exit-secs", "2", "--orphan-grace-secs", "1"])
        .arg("--log-dir").arg(root.join("logs"))
        .stdout(Stdio::piped()).stderr(Stdio::piped())
        .output().unwrap();
    assert!(out.status.success(), "{out:?}");

    let mut c = connect(&ep).await;
    let (sh, args) = shell();
    let r = call(&mut c, 1, "terminal.spawn", json!({
        "id": "orphan", "shell": sh, "args": args, "cwd": root.to_string_lossy(), "env": env_now(),
        "cols": 80, "rows": 24, "tag": ""
    })).await;
    let pid = r["result"]["info"]["pid"].as_u64().unwrap();
    let host_pid = call(&mut c, 2, "status", json!({})).await["result"]["pid"].as_u64().unwrap() as u32;
    drop(c);
    // No client re-attaches: after the 1 s grace the terminal is killed, then the idle host exits.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut host_gone = false;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
        // Poll the process, not the endpoint: a probe connection would count as a client.
        if !process_alive(host_pid) { host_gone = true; break; }
    }
    let log = std::fs::read_to_string(root.join("logs").join("pegasus-host.log")).unwrap_or_default();
    assert!(host_gone, "host still running; log:\n{log}");
    assert!(log.contains("terminal orphan: no client re-attached"), "{log}");
    assert!(!process_alive(pid as u32), "shell {pid} survived");
}

fn process_alive(pid: u32) -> bool {
    if cfg!(windows) {
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    } else {
        Command::new("kill").args(["-0", &pid.to_string()]).status().is_ok_and(|s| s.success())
    }
}

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// One raw HTTP/1.1 request; returns (status, body).
async fn http(port: u16, head: &str, body: &str) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let req = format!("{head}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    let status = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    (status, out.splitn(2, "\r\n\r\n").nth(1).unwrap_or("").to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_api_serves_native_clients_without_origin_and_only_binds_tailscale() {
    let root = std::env::temp_dir().join(format!("pegasus-host-remote-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("remote");
    let _host = spawn(&ep, &root, 600);
    let mut c = connect(&ep).await;
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let token = "t".repeat(40);
    let bad = call(&mut c, 1, "remote.serve", json!({"port": port, "allowedOrigins": ["file://"],
        "clients": [{"id": "phone", "tokenSha256": sha256_hex(&token)}], "extraBinds": ["192.168.1.5"]})).await;
    assert_eq!(bad["error"]["code"], "bad_params", "a LAN address must be refused: {bad}");
    let ok = call(&mut c, 2, "remote.serve", json!({"port": port, "allowedOrigins": ["file://"],
        "clients": [{"id": "phone", "tokenSha256": sha256_hex(&token)}]})).await;
    assert!(ok.get("result").is_some(), "{ok}");

    // The phone's request: no Origin. The provider (this connection) answers the relayed call.
    let head = format!("POST /v1/invoke HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\n");
    let request = tokio::spawn(async move { http(port, &head, r#"{"method":"getState","args":[]}"#).await });
    let ev = loop {
        let v = recv(&mut c).await;
        if v["event"] == "remoteInvoke" { break v; }
    };
    assert_eq!(ev["data"]["clientId"], "phone");
    assert_eq!(ev["data"]["method"], "getState");
    let rid = ev["data"]["requestId"].clone();
    send(&mut c, json!({"v":2,"id":3,"method":"remote.reply","params":{"requestId": rid, "ok": true, "value": {"workspaces": []}}})).await;
    let (status, body) = request.await.unwrap();
    assert_eq!(status, 200, "{body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({"version": 1, "result": {"workspaces": []}}));

    // Without a token it is refused before anything reaches the provider.
    let head = format!("POST /v1/invoke HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n");
    assert_eq!(http(port, &head, "{}").await.0, 401);
}

/// One raw request; returns (status, headers, decoded body, bytes on the wire for the body).
async fn http_raw(port: u16, head: &str, body: &str) -> (u16, String, String, usize) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let req = format!("{head}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = vec![];
    s.read_to_end(&mut out).await.unwrap();
    let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    let headers = String::from_utf8_lossy(&out[..split]).to_ascii_lowercase();
    let status = headers.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let wire = &out[split..];
    let decoded = if headers.contains("content-encoding: br") {
        let mut d = String::new();
        std::io::Read::read_to_string(&mut brotli::Decompressor::new(wire, 4096), &mut d).unwrap();
        d
    } else {
        String::from_utf8_lossy(wire).into_owned()
    };
    (status, headers, decoded, wire.len())
}

/// Varied prose (xorshift over a word list), so Brotli compresses it about as well as real chats.
fn words(seed: u64, n: usize) -> String {
    const W: [&str; 32] = ["host", "phone", "route", "paging", "delta", "review", "diff", "hunk", "token", "stream", "error", "cargo", "test", "build", "merge", "state",
        "render", "window", "commit", "branch", "cache", "budget", "bytes", "latency", "session", "entry", "title", "preview", "status", "unread", "project", "chat"];
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..n).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; if x % 7 == 0 { format!("{}{}", W[(x >> 8) as usize % 32], x % 997) } else { W[(x >> 8) as usize % 32].to_string() } })
        .collect::<Vec<_>>().join(" ")
}

/// A desktop state and a long transcript shaped like the real ones (apps/mobile/src/api/types.ts).
fn fake_desktop(sessions_per_ws: usize, entries: usize) -> (Value, Value, Value) {
    let mut workspaces = vec![];
    let mut usage = serde_json::Map::new();
    for w in 0..12 {
        let sessions: Vec<Value> = (0..sessions_per_ws).map(|s| {
            usage.insert(format!("w{w}:s{s}"), json!({"subscription": true, "totals": {"cost": 1.5, "input": 120000, "output": 9000, "cacheRead": 800000},
                "planLimits": {"provider": "anthropic", "reportedAt": "2026-11-23T10:00:00Z", "limits": [{"windowMinutes": 300, "usedPercent": 41.5, "resetsAt": "2026-11-23T15:00:00Z"}, {"windowMinutes": 10080, "usedPercent": 12.0}]}}));
            json!({"id": format!("s{s}-0b6f3c9e-5d2a-4f1b-9c3e"), "title": words((w * 1000 + s) as u64, 6),
                "updatedAt": format!("2026-11-{:02}T10:{:02}:00.000Z", 1 + s % 28, s % 60), "lastInteractedAt": format!("2026-11-{:02}T09:00:00.000Z", 1 + s % 28),
                "preview": words((w * 1000 + s) as u64 + 7, 80),
                "status": if s == 0 { "running" } else { "idle" }, "hasUnseenUpdate": s % 5 == 0, "runningSince": if s == 0 { json!("2026-11-23T10:00:00Z") } else { Value::Null },
                "cwd": format!("D:/Pi/projects/p{w}"), "sessionFile": format!("D:/Pi/pi-ecosystem/.state/agent/sessions/p{w}/2026-11-23T10-00-00_{s}.jsonl"),
                "model": {"provider": "anthropic", "id": "claude-opus-5-5", "thinkingLevel": "high"}})
        }).collect();
        workspaces.push(json!({"id": format!("w{w}"), "name": format!("Project {w}"), "path": format!("D:/Pi/projects/p{w}"), "kind": "local", "sessions": sessions}));
    }
    let state = json!({"revision": 4242, "workspaces": workspaces, "selectedWorkspaceId": "w0", "selectedSessionId": "s0-0b6f3c9e-5d2a-4f1b-9c3e",
        "sessionUsageBySession": usage, "workspaceOrder": (0..12).map(|w| format!("w{w}")).collect::<Vec<_>>(), "pinnedSessionOrder": ["w0:s1-0b6f3c9e-5d2a-4f1b-9c3e"]});
    let items: Vec<Value> = (0..entries).map(|i| match i % 4 {
        0 => json!({"kind": "message", "id": format!("e{i}"), "role": "user", "text": words(i as u64, 40), "createdAt": "2026-11-23T10:00:00Z"}),
        1 => json!({"kind": "thinking", "id": format!("e{i}"), "text": words(i as u64, 120), "createdAt": "2026-11-23T10:00:00Z", "durationMs": 2300}),
        2 => json!({"kind": "tool", "id": format!("e{i}"), "toolName": "project_shell", "status": "success", "label": words(i as u64 + 3, 4),
            "detail": words(i as u64 + 5, if i % 40 == 2 { 6000 } else { 300 }), "createdAt": "2026-11-23T10:00:00Z"}),
        _ => json!({"kind": "message", "id": format!("e{i}"), "role": "assistant", "text": words(i as u64 + 9, 150), "createdAt": "2026-11-23T10:00:00Z"}),
    }).collect();
    let transcript = json!({"workspaceId": "w0", "sessionId": "s0-0b6f3c9e-5d2a-4f1b-9c3e", "transcript": items});
    let mut patch = String::from("diff --git a/src/remote.rs b/src/remote.rs\nindex 1111111..2222222 100644\n--- a/src/remote.rs\n+++ b/src/remote.rs\n");
    for h in 0..200 {
        patch.push_str(&format!("@@ -{0},11 +{0},13 @@ impl Remote {{\n", 1 + h * 40));
        for l in 0..14 {
            let tag = if l < 10 { ' ' } else if l < 12 { '-' } else { '+' };
            if tag == '-' && l == 11 { continue; }
            patch.push_str(&format!("{tag}        let {} = {};\n", words((h * 100 + l) as u64, 1), words((h * 100 + l) as u64 + 1, 8)));
        }
        patch.push_str(&format!("+        // hunk {h}\n"));
    }
    let file = json!({"state": "available", "reviewId": "r1", "fileId": "f1", "patch": patch, "coverage": {"state": "complete", "notes": []}});
    (state, transcript, file)
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_routes_shrink_the_wire_and_keep_auth() {
    let root = std::env::temp_dir().join(format!("pegasus-host-phone-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("phone");
    let _host = spawn(&ep, &root, 600);
    let mut c = connect(&ep).await;
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let token = "p".repeat(40);
    let ok = call(&mut c, 1, "remote.serve", json!({"port": port, "allowedOrigins": ["file://"],
        "clients": [{"id": "phone", "tokenSha256": sha256_hex(&token)}]})).await;
    assert!(ok.get("result").is_some(), "{ok}");
    let (state, transcript, file) = fake_desktop(40, 2000);
    // The fake desktop: answers every relayed read with the canned payloads.
    tokio::spawn(async move {
        let mut id = 10;
        loop {
            let v = recv(&mut c).await;
            if v["event"] != "remoteInvoke" { continue; }
            let value = match v["data"]["method"].as_str().unwrap() {
                "getState" => state.clone(),
                "getSelectedTranscript" => transcript.clone(),
                "getReviewFile" => file.clone(),
                _ => Value::Null,
            };
            id += 1;
            send(&mut c, json!({"v":2,"id":id,"method":"remote.reply","params":{"requestId": v["data"]["requestId"], "ok": true, "value": value}})).await;
        }
    });
    let auth = format!("Host: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nAccept-Encoding: br\r\n");
    let post = |path: &str| format!("POST {path} HTTP/1.1\r\n{auth}Content-Type: application/json\r\n");
    let get = |path: &str| format!("GET {path} HTTP/1.1\r\n{auth}");
    let timed = async |head: String, body: &str| {
        let t = Instant::now();
        let r = http_raw(port, &head, body).await;
        (r, t.elapsed().as_secs_f64() * 1000.0)
    };
    let report = |name: &str, r: &(u16, String, String, usize), ms: f64| eprintln!("MEASURE {name}: status {} wire {} B, json {} B, {ms:.1} ms", r.0, r.3, r.2.len());

    // Before: what the phone calls today.
    let (st, ms) = timed(post("/v1/invoke"), r#"{"method":"getState","args":[]}"#).await;
    report("invoke getState", &st, ms);
    let (tr, ms) = timed(post("/v1/invoke"), r#"{"method":"getSelectedTranscript","args":[]}"#).await;
    report("invoke getSelectedTranscript", &tr, ms);
    let (rf, ms) = timed(post("/v1/invoke"), r#"{"method":"getReviewFile","args":[{"reviewId":"r1","fileId":"f1"}]}"#).await;
    report("invoke getReviewFile", &rf, ms);
    assert_eq!(st.0, 200);

    // After: the phone routes.
    let (chats, ms) = timed(get("/v1/phone/chats"), "").await;
    report("phone/chats", &chats, ms);
    assert_eq!(chats.0, 200, "{}", chats.2);
    let list: Value = serde_json::from_str(&chats.2).unwrap();
    assert_eq!(list["result"]["chats"].as_array().unwrap().len(), 12 * 40);
    let etag = list["result"]["etag"].as_str().unwrap().to_string();
    assert!(chats.1.contains(&format!("etag: \"{etag}\"")), "{}", chats.1);
    let (same, ms) = timed(format!("GET /v1/phone/chats HTTP/1.1\r\n{auth}If-None-Match: \"{etag}\"\r\n"), "").await;
    report("phone/chats unchanged (304)", &same, ms);
    assert_eq!((same.0, same.3), (304, 0));
    assert!(chats.3 * 2 < st.3, "chat list {} B vs state {} B", chats.3, st.3);

    let (page, ms) = timed(post("/v1/phone/transcript"), r#"{"workspaceId":"w0","sessionId":"s0-0b6f3c9e-5d2a-4f1b-9c3e","limit":50}"#).await;
    report("phone/transcript newest 50", &page, ms);
    assert_eq!(page.0, 200, "{}", page.2);
    let p: Value = serde_json::from_str(&page.2).unwrap();
    assert_eq!((p["result"]["start"].as_u64(), p["result"]["total"].as_u64()), (Some(1950), Some(2000)));
    assert!(page.3 * 10 < tr.3, "page {} B vs transcript {} B", page.3, tr.3);
    let (older, ms) = timed(post("/v1/phone/transcript"), r#"{"workspaceId":"w0","sessionId":"s0-0b6f3c9e-5d2a-4f1b-9c3e","limit":50,"before":"e1950"}"#).await;
    report("phone/transcript older 50", &older, ms);
    assert_eq!(serde_json::from_str::<Value>(&older.2).unwrap()["result"]["entries"][49]["id"], "e1949");
    let wrong = http_raw(port, &post("/v1/phone/transcript"), r#"{"workspaceId":"w0","sessionId":"other"}"#).await;
    assert_eq!(wrong.0, 409, "{}", wrong.2);
    let gone = http_raw(port, &post("/v1/phone/transcript"), r#"{"workspaceId":"w0","sessionId":"s0-0b6f3c9e-5d2a-4f1b-9c3e","before":"nope"}"#).await;
    assert_eq!(gone.0, 410);
    let extra = http_raw(port, &post("/v1/phone/transcript"), r#"{"workspaceId":"w0","sessionId":"s","x":1}"#).await;
    assert_eq!(extra.0, 400);

    let (diff, ms) = timed(post("/v1/phone/diff"), r#"{"reviewId":"r1","fileId":"f1"}"#).await;
    report("phone/diff default cap", &diff, ms);
    let d: Value = serde_json::from_str(&diff.2).unwrap();
    assert_eq!(d["result"]["diff"]["files"][0]["hunks"].as_array().unwrap().len(), 200, "{}", &diff.2[..300]);
    assert!(d["result"].get("patch").is_none());
    let (capped, ms) = timed(post("/v1/phone/diff"), r#"{"reviewId":"r1","fileId":"f1","maxBytes":4096}"#).await;
    report("phone/diff maxBytes 4096", &capped, ms);
    let cd: Value = serde_json::from_str(&capped.2).unwrap();
    assert_eq!(cd["result"]["diff"]["truncated"], true);
    assert!(capped.2.len() < 4096 + 8192, "{} B", capped.2.len());

    // Same gate as every other route: no token, a wrong token, a foreign origin or Host are refused.
    for path in ["/v1/phone/chats", "/v1/phone/transcript", "/v1/phone/diff"] {
        let m = if path.ends_with("chats") { "GET" } else { "POST" };
        let none = format!("{m} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n");
        assert_eq!(http_raw(port, &none, "{}").await.0, 401, "{path}");
        let bad = format!("{m} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\n", "q".repeat(40));
        assert_eq!(http_raw(port, &bad, "{}").await.0, 401, "{path}");
        let origin = format!("{m} {path} HTTP/1.1\r\n{auth}Origin: https://evil.example\r\nContent-Type: application/json\r\n");
        assert_eq!(http_raw(port, &origin, "{}").await.0, 403, "{path}");
        let host = format!("{m} {path} HTTP/1.1\r\nHost: evil.example:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\n");
        assert_eq!(http_raw(port, &host, "{}").await.0, 400, "{path}");
    }
    assert_eq!(http_raw(port, &get("/v1/phone/nope"), "").await.0, 404);
    assert_eq!(http_raw(port, &get("/v1/phone/chats?x=1"), "").await.0, 400);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_updates_are_served_without_a_token_but_only_to_known_hosts() {
    let root = std::env::temp_dir().join(format!("pegasus-host-updates-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let updates = root.join("mobile-updates");
    let id = "0b6f3c9e-5d2a-4f1b-9c3e-7a8d6e5f4c3b";
    std::fs::create_dir_all(updates.join("updates").join(id)).unwrap();
    std::fs::create_dir_all(updates.join("assets")).unwrap();
    std::fs::write(updates.join("latest.json"), format!(r#"{{"rv1":"{id}"}}"#)).unwrap();
    std::fs::write(updates.join("updates").join(id).join("manifest.json"), format!(r#"{{"id":"{id}","runtimeVersion":"rv1"}}"#)).unwrap();
    std::fs::write(updates.join("updates").join(id).join("signature"), r#"sig="abc", keyid="main""#).unwrap();
    let asset = "a".repeat(64) + ".hbc";
    std::fs::write(updates.join("assets").join(&asset), "bundle").unwrap();
    let ep = endpoint("updates");
    let _host = Proc(Command::new(env!("CARGO_BIN_EXE_pegasus-host"))
        .args(["--endpoint", &ep, "--sessions-root"]).arg(root.join("sessions"))
        .args(["--idle-exit-secs", "600"])
        .env("PEGASUS_MOBILE_UPDATES_DIR", &updates)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().unwrap());
    let mut c = connect(&ep).await;
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let ok = call(&mut c, 1, "remote.serve", json!({"port": port, "allowedOrigins": ["file://"],
        "clients": [{"id": "phone", "tokenSha256": sha256_hex(&"t".repeat(40))}]})).await;
    assert!(ok.get("result").is_some(), "{ok}");

    // What the iOS client sends (FileDownloader.swift), no Authorization.
    let head = format!("GET /v1/updates/manifest HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: multipart/mixed,application/expo+json,application/json\r\nExpo-Platform: ios\r\nExpo-Protocol-Version: 1\r\nExpo-Runtime-Version: rv1\r\n");
    let (status, body) = http(port, &head, "").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains(&format!("expo-signature: sig=\"abc\", keyid=\"main\"\r\n\r\n{{\"id\":\"{id}\"")), "{body}");
    let head = format!("GET /v1/updates/assets/{asset} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
    assert_eq!(http(port, &head, "").await, (200, "bundle".to_string()));
    let head = format!("GET /v1/updates/assets/../latest.json HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
    assert_eq!(http(port, &head, "").await.0, 404);
    // DNS rebinding: a page on another name cannot reach these routes either.
    let head = format!("GET /v1/updates/assets/{asset} HTTP/1.1\r\nHost: evil.example:{port}\r\n");
    assert_eq!(http(port, &head, "").await.0, 400);
    // Everything else still needs the token.
    let head = format!("GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
    assert_eq!(http(port, &head, "").await.0, 401);
    let _ = std::fs::remove_dir_all(&root);
}

/// Reads an SSE stream until `until` matches the text so far (or 10 s pass); returns the body text.
async fn sse_until(s: &mut tokio::net::TcpStream, until: impl Fn(&str) -> bool) -> String {
    use tokio::io::AsyncReadExt;
    let mut out = String::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut buf = [0u8; 8192];
    while !until(&out) {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, s.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            _ => panic!("stream ended or timed out; so far:\n{out}"),
        }
    }
    out
}

async fn open_events(port: u16, token: &str, last_event_id: Option<&str>) -> tokio::net::TcpStream {
    use tokio::io::AsyncWriteExt;
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let resume = last_event_id.map(|id| format!("Last-Event-ID: {id}\r\n")).unwrap_or_default();
    let req = format!("GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nAccept: text/event-stream\r\n{resume}\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    s
}

/// The ids of the frames in an SSE body, in order.
fn sse_ids(body: &str) -> Vec<String> {
    body.lines().filter_map(|l| l.strip_prefix("id: ")).map(str::to_string).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn event_stream_resumes_after_last_event_id_and_invoke_runs_once_per_idempotency_key() {
    let root = std::env::temp_dir().join(format!("pegasus-host-resume-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("resume");
    let _host = spawn(&ep, &root, 600);
    let mut c = connect(&ep).await;
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let token = "r".repeat(40);
    let ok = call(&mut c, 1, "remote.serve", json!({"port": port, "allowedOrigins": ["file://"],
        "clients": [{"id": "phone", "tokenSha256": sha256_hex(&token)}]})).await;
    assert!(ok.get("result").is_some(), "{ok}");
    // The fake desktop: counts calls per method, answers getState with revision 1, publishes on demand.
    let (publish_tx, mut publish_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let calls = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::<String, usize>::new()));
    let calls2 = calls.clone();
    tokio::spawn(async move {
        let mut id = 100;
        loop {
            tokio::select! {
                v = recv(&mut c) => {
                    if v["event"] != "remoteInvoke" { continue; }
                    let method = v["data"]["method"].as_str().unwrap().to_string();
                    *calls2.lock().unwrap().entry(method.clone()).or_default() += 1;
                    if method == "sendText" { tokio::time::sleep(Duration::from_millis(300)).await; }
                    let value = match method.as_str() {
                        "getState" => json!({"revision": 1, "workspaces": []}),
                        "sendText" => json!({"accepted": true}),
                        _ => Value::Null,
                    };
                    id += 1;
                    send(&mut c, json!({"v":2,"id":id,"method":"remote.reply","params":{"requestId": v["data"]["requestId"], "ok": true, "value": value}})).await;
                }
                Some(event) = publish_rx.recv() => {
                    id += 1;
                    send(&mut c, json!({"v":2,"id":id,"method":"remote.publish","params":{"clientId": "phone", "event": event}})).await;
                }
            }
        }
    });
    let state = |r: u64| json!({"type": "stateChanged", "state": {"revision": r, "workspaces": []}});

    // A new stream: ready, then the baseline (state and transcript), each with an id.
    let mut s = open_events(port, &token, None).await;
    let first = sse_until(&mut s, |b| b.contains("selectedTranscriptChanged")).await;
    assert!(first.contains(r#""resumed":false"#), "{first}");
    publish_tx.send(state(2)).unwrap();
    let body = first + &sse_until(&mut s, |b| b.contains(r#""revision":2"#)).await;
    let seen = sse_ids(&body);
    assert_eq!(seen.len(), 3, "baseline state, transcript, revision 2: {body}");
    drop(s);

    // While the phone is away two more events happen; they are kept for its return.
    tokio::time::sleep(Duration::from_millis(200)).await;
    publish_tx.send(state(3)).unwrap();
    publish_tx.send(json!({"type": "sessionTranscriptDelta", "delta": {"version": 1, "sequence": 1, "workspaceId": "w", "sessionId": "s", "patches": []}})).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Resuming after the last id it saw: exactly the missed events, no new baseline.
    let mut s = open_events(port, &token, seen.last().map(String::as_str)).await;
    let body = sse_until(&mut s, |b| b.contains("sessionTranscriptDelta")).await;
    assert!(body.contains(r#""resumed":true"#), "{body}");
    assert!(body.contains(r#""revision":3"#) && !body.contains("selectedTranscriptChanged"), "{body}");
    let resumed_ids = sse_ids(&body);
    assert_eq!(resumed_ids.len(), 2, "{body}");
    drop(s);
    assert_eq!(calls.lock().unwrap().get("getState"), Some(&1), "a resume pulls no state");

    // An id the host cannot resume (another host run, or too old) gets a whole baseline.
    let mut s = open_events(port, &token, Some("otherepoch-5")).await;
    let body = sse_until(&mut s, |b| b.contains("selectedTranscriptChanged")).await;
    assert!(body.contains(r#""resumed":false"#), "{body}");
    drop(s);

    // The same message sent twice with one Idempotency-Key (a double tap, a resent POST) reaches the
    // desktop once; both requests get its answer. Another key is another message.
    let send_text = |key: &str| {
        let head = format!("POST /v1/invoke HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nIdempotency-Key: {key}\r\n");
        async move { http(port, &head, r#"{"method":"sendText","args":["hello"]}"#).await }
    };
    let (a, b) = tokio::join!(send_text("send-0001-aaaa"), send_text("send-0001-aaaa"));
    assert_eq!(a, b);
    assert_eq!(a.0, 200, "{}", a.1);
    assert_eq!(send_text("send-0001-aaaa").await.0, 200);
    assert_eq!(calls.lock().unwrap().get("sendText"), Some(&1), "one key, one send");
    assert_eq!(send_text("send-0002-bbbb").await.0, 200);
    assert_eq!(calls.lock().unwrap().get("sendText"), Some(&2));
    // The same key for a different call is refused, not answered with the first call's result.
    let head = format!("POST /v1/invoke HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nIdempotency-Key: send-0002-bbbb\r\n");
    assert_eq!(http(port, &head, r#"{"method":"sendText","args":["other"]}"#).await.0, 422);
    let head = format!("POST /v1/invoke HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nIdempotency-Key: bad key\r\n");
    assert_eq!(http(port, &head, r#"{"method":"sendText","args":["x"]}"#).await.0, 400);
    assert_eq!(calls.lock().unwrap().get("sendText"), Some(&2));
    let _ = std::fs::remove_dir_all(&root);
}
