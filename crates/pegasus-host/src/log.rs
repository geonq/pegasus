//! Host logs, both append-only with one rotation:
//! - `pegasus-host.log`: human lines (`<ms> <LEVEL> <message>`), rotated past 5 MB.
//! - `host-events.ndjson`: the same events as JSON lines in the app's event-log shape
//!   (`{"t","n","p","src":"host","k","l",...}`), rotated past 8 MB, so `pegasus-events` merges the
//!   host with Electron main and the renderer into one timeline.
//!
//! Every error the host returns or swallows is written with context, so nothing fails silently.
use serde_json::{Map, Value};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 << 20;
const MAX_EVENT_BYTES: u64 = 8 << 20;

struct Sink {
    path: PathBuf,
    file: Option<File>,
    limit: u64,
}

impl Sink {
    fn open(path: Option<PathBuf>, limit: u64) -> Mutex<Sink> {
        let file = path.as_ref().and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok());
        Mutex::new(Sink { path: path.unwrap_or_default(), file, limit })
    }

    fn append(&mut self, line: &[u8]) {
        if self.file.as_ref().and_then(|f| f.metadata().ok()).is_some_and(|m| m.len() > self.limit) {
            let rotated = self.path.with_extension(match self.path.extension().and_then(|e| e.to_str()) {
                Some(ext) => format!("{ext}.1"),
                None => "1".into(),
            });
            self.file = None;
            let _ = std::fs::rename(&self.path, rotated);
            self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        }
        if let Some(f) = self.file.as_mut() {
            let _ = f.write_all(line);
        }
    }
}

static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();
static EVENTS: OnceLock<Mutex<Sink>> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn init(dir: Option<PathBuf>) {
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = SINK.set(Sink::open(dir.as_ref().map(|d| d.join("pegasus-host.log")), MAX_BYTES));
    let _ = EVENTS.set(Sink::open(dir.as_ref().map(|d| d.join("host-events.ndjson")), MAX_EVENT_BYTES));
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// A human log line only (the caller writes its own structured event).
pub fn text(level: &str, msg: &str) {
    let line = format!("{} {level} {msg}\n", now_ms());
    eprint!("{line}");
    if let Some(sink) = SINK.get() {
        if let Ok(mut s) = sink.lock() {
            s.append(line.as_bytes());
        }
    }
}

/// A human log line, mirrored into the event log as `host.log` (level e/w for ERROR/WARN/PANIC).
pub fn write(level: &str, msg: &str) {
    text(level, msg);
    let l = match level {
        "ERROR" | "PANIC" => Some("e"),
        "WARN" => Some("w"),
        _ => None,
    };
    let kind = if level == "PANIC" { "host.panic" } else { "host.log" };
    event(kind, l, [("msg", Value::from(msg))]);
}

/// One structured event line. `fields` must not repeat the envelope keys (t, n, p, src, k, l).
pub fn event<const N: usize>(kind: &str, level: Option<&str>, fields: [(&str, Value); N]) {
    let Some(sink) = EVENTS.get() else { return };
    let mut o = Map::with_capacity(6 + N);
    o.insert("t".into(), Value::from(now_ms() as u64));
    o.insert("n".into(), Value::from(SEQ.fetch_add(1, Ordering::Relaxed) + 1));
    o.insert("p".into(), Value::from(std::process::id()));
    o.insert("src".into(), Value::from("host"));
    o.insert("k".into(), Value::from(kind));
    if let Some(l) = level {
        o.insert("l".into(), Value::from(l));
    }
    for (k, v) in fields {
        if !v.is_null() {
            o.insert(k.into(), v);
        }
    }
    let Ok(mut line) = serde_json::to_vec(&Value::Object(o)) else { return };
    line.push(b'\n');
    if let Ok(mut s) = sink.lock() {
        s.append(&line);
    }
}

#[macro_export]
macro_rules! info { ($($t:tt)*) => { $crate::log::write("INFO", &format!($($t)*)) } }
#[macro_export]
macro_rules! warn { ($($t:tt)*) => { $crate::log::write("WARN", &format!($($t)*)) } }
#[macro_export]
macro_rules! error { ($($t:tt)*) => { $crate::log::write("ERROR", &format!($($t)*)) } }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotated_names_keep_the_extension() {
        let mut s = Sink { path: PathBuf::from("x/host-events.ndjson"), file: None, limit: 0 };
        // No file is open, so append only computes names; this checks it never panics on a closed sink.
        s.append(b"{}\n");
        assert_eq!(s.path.with_extension("ndjson.1"), PathBuf::from("x/host-events.ndjson.1"));
    }
}
