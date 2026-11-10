//! Append-only host log with one rotation (`pegasus-host.log` -> `.log.1` past 5 MB). Every error the
//! host returns or swallows is written here with context, so nothing fails silently.
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 << 20;

struct Sink {
    path: PathBuf,
    file: Option<File>,
}

static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();

pub fn init(dir: Option<PathBuf>) {
    let path = dir.map(|d| {
        let _ = std::fs::create_dir_all(&d);
        d.join("pegasus-host.log")
    });
    let file = path.as_ref().and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok());
    let _ = SINK.set(Mutex::new(Sink { path: path.unwrap_or_default(), file }));
}

pub fn write(level: &str, msg: &str) {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let line = format!("{ms} {level} {msg}\n");
    eprint!("{line}");
    let Some(sink) = SINK.get() else { return };
    let Ok(mut s) = sink.lock() else { return };
    if s.file.as_ref().and_then(|f| f.metadata().ok()).is_some_and(|m| m.len() > MAX_BYTES) {
        let rotated = s.path.with_extension("log.1");
        s.file = None;
        let _ = std::fs::rename(&s.path, rotated);
        s.file = OpenOptions::new().create(true).append(true).open(&s.path).ok();
    }
    if let Some(f) = s.file.as_mut() {
        let _ = f.write_all(line.as_bytes());
    }
}

#[macro_export]
macro_rules! info { ($($t:tt)*) => { $crate::log::write("INFO", &format!($($t)*)) } }
#[macro_export]
macro_rules! warn { ($($t:tt)*) => { $crate::log::write("WARN", &format!($($t)*)) } }
#[macro_export]
macro_rules! error { ($($t:tt)*) => { $crate::log::write("ERROR", &format!($($t)*)) } }
