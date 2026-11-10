//! Read-only reader for pi session JSONL files (version 3 tree format, linearised in file order).
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub struct Chat { pub path: PathBuf, pub title: String, pub cwd: String }
pub struct Project { pub name: String, pub chats: Vec<Chat> }
#[derive(Clone)]
pub struct Msg { pub role: Role, pub text: String }
#[derive(Clone, Copy, PartialEq)]
pub enum Role { User, Assistant, Tool, Result }

fn short(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n { s } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

fn blocks_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Header only: cwd + session name (or first user text). Stops early; never loads whole files.
fn head(path: &Path) -> Option<Chat> {
    let mut cwd = String::new();
    let mut title = String::new();
    let mut first_user = String::new();
    let mut rd = BufReader::new(File::open(path).ok()?);
    let mut buf = Vec::new();
    for i in 0..80 {
        buf.clear();
        if rd.read_until(b'\n', &mut buf).ok()? == 0 { break; }
        // Cheap prefix test first: only the three line kinds we need get parsed; blobs are skipped.
        let want = buf.starts_with(br#"{"type":"session""#) || buf.starts_with(br#"{"type":"session_info""#)
            || (buf.starts_with(br#"{"type":"message""#) && buf.len() < 200_000 && first_user.is_empty());
        if !want { continue; }
        let v: Value = serde_json::from_slice(&buf).ok()?;
        match v["type"].as_str() {
            Some("session") => cwd = v["cwd"].as_str().unwrap_or("").to_string(),
            Some("session_info") => title = v["name"].as_str().unwrap_or("").to_string(),
            Some("message") if v["message"]["role"] == "user" && first_user.is_empty() => {
                first_user = blocks_text(&v["message"]["content"]);
            }
            _ => {}
        }
        if (!title.is_empty() || !first_user.is_empty()) && i > 3 && !cwd.is_empty() { break; }
    }
    let t = if title.is_empty() { first_user } else { title };
    Some(Chat { path: path.to_path_buf(), title: short(&t, 60), cwd })
}

pub fn scan(root: &Path) -> Vec<Project> {
    let mut by: BTreeMap<String, Vec<(String, Chat)>> = BTreeMap::new();
    let Ok(dirs) = std::fs::read_dir(root) else { return vec![] };
    for d in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().is_some_and(|e| e == "jsonl") {
                let stamp = p.file_name().unwrap().to_string_lossy().to_string();
                if let Some(c) = head(&p) {
                    let name = c.cwd.rsplit(['\\', '/']).next().unwrap_or("?").to_string();
                    by.entry(name).or_default().push((stamp, c));
                }
            }
        }
    }
    by.into_iter().map(|(name, mut v)| {
        v.sort_by(|a, b| b.0.cmp(&a.0)); // newest first (filename starts with ISO timestamp)
        Project { name, chats: v.into_iter().map(|x| x.1).collect() }
    }).collect()
}

pub fn load(path: &Path) -> Vec<Msg> {
    let mut out = vec![];
    let Ok(f) = File::open(path) else { return out };
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if !line.starts_with(r#"{"type":"message""#) { continue } // skip system/compaction blobs unparsed
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let m = &v["message"];
        match m["role"].as_str() {
            Some("user") => out.push(Msg { role: Role::User, text: blocks_text(&m["content"]) }),
            Some("assistant") => {
                if let Some(a) = m["content"].as_array() {
                    for b in a {
                        match b["type"].as_str() {
                            Some("text") => out.push(Msg { role: Role::Assistant, text: b["text"].as_str().unwrap_or("").into() }),
                            Some("toolCall") => out.push(Msg { role: Role::Tool, text: format!("{} {}", b["name"].as_str().unwrap_or("?"), short(&b["arguments"].to_string(), 160)) }),
                            _ => {}
                        }
                    }
                }
            }
            Some("toolResult") => out.push(Msg { role: Role::Result, text: short(&blocks_text(&m["content"]), 400) }),
            _ => {}
        }
    }
    out.retain(|m| !m.text.trim().is_empty());
    out
}
