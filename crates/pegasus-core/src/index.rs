//! Session index: one summary per `.jsonl`, computed in a single streaming pass and cached by
//! (size, mtime). Appended files resume from the byte offset where the last scan stopped.
//! Mirrors pi's `buildSessionInfo` (SessionManager.list) minus `allMessagesText`.
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

const CACHE_FORMAT: u32 = 1;
const HEAD_BYTES: usize = 256;

/// Scan state per file. Everything but the derived output fields is what a resume needs.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct FileIndex {
    pub size: u64,
    pub mtime_ms: f64,
    /// Offset just past the last complete line already folded into the counters.
    pub scanned_to: u64,
    /// FNV-1a of the first bytes: a rewritten (not appended) file fails this and is rescanned.
    pub head_hash: u64,
    pub id: String,
    pub cwd: String,
    pub parent_session: Option<String>,
    pub version: u32,
    pub created_ms: Option<f64>,
    pub message_count: u32,
    pub first_message: String,
    pub name: Option<String>,
    pub last_activity_ms: Option<f64>,
}

pub use crate::protocol::SessionSummary;

#[derive(Deserialize)]
struct Line<'a> {
    #[serde(rename = "type", borrow)]
    ty: Option<Cow<'a, str>>,
    #[serde(borrow)]
    id: Option<Cow<'a, str>>,
    #[serde(borrow)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow)]
    cwd: Option<Cow<'a, str>>,
    #[serde(borrow, rename = "parentSession")]
    parent_session: Option<Cow<'a, str>>,
    #[serde(borrow)]
    name: Option<Cow<'a, str>>,
    version: Option<u32>,
    #[serde(borrow)]
    message: Option<Msg<'a>>,
}

#[derive(Deserialize)]
struct Msg<'a> {
    #[serde(borrow)]
    role: Option<Cow<'a, str>>,
    timestamp: Option<f64>,
    #[serde(borrow)]
    content: Option<&'a RawValue>,
}

pub fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// ISO-8601 `YYYY-MM-DDTHH:MM:SS[.fff](Z|+HH:MM)` to epoch ms (what pi writes); anything else is None.
pub fn parse_iso_ms(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> { std::str::from_utf8(b.get(r)?).ok()?.parse().ok() };
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, m, d, hh, mm, ss) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let mut i = 19;
    let mut millis = 0i64;
    if b[i] == b'.' {
        let start = i + 1;
        i = start;
        while i < b.len() && b[i].is_ascii_digit() { i += 1; }
        let digits = &s[start..i];
        millis = format!("{:0<3}", &digits[..digits.len().min(3)]).parse().ok()?;
    }
    let off = match b.get(i)? {
        b'Z' => 0,
        sign @ (b'+' | b'-') => {
            let h = num(i + 1..i + 3)?;
            let m = num(i + 4..i + 6)?;
            let v = h * 60 + m;
            if *sign == b'+' { v } else { -v }
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + hh * 3600 + mm * 60 + ss - off * 60;
    Some((secs * 1000 + millis) as f64)
}

/// Text of a message's `content` as pi's `extractTextContent`: string, or text blocks joined by " ".
fn content_text(raw: &RawValue) -> String {
    match serde_json::from_str::<serde_json::Value>(raw.get()) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Array(a)) => a
            .iter()
            .filter(|b| b["type"] == "text")
            .map(|b| b["text"].as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

impl FileIndex {
    /// Fold one JSON line into the state. Returns false when the file is not a pi session
    /// (first parsed line is not a header).
    fn apply(&mut self, line: &[u8], first: bool) -> bool {
        let Ok(l) = serde_json::from_slice::<Line>(line) else { return true }; // malformed lines are skipped, as pi does
        let ty = l.ty.as_deref().unwrap_or("");
        if first {
            if ty != "session" { return false }
            self.id = l.id.map(Cow::into_owned).unwrap_or_default();
            self.cwd = l.cwd.map(Cow::into_owned).unwrap_or_default();
            self.parent_session = l.parent_session.map(Cow::into_owned);
            self.version = l.version.unwrap_or(1);
            self.created_ms = l.timestamp.as_deref().and_then(parse_iso_ms);
            return true;
        }
        if ty == "session_info" {
            self.name = l.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        }
        if ty != "message" { return true }
        self.message_count += 1;
        let Some(m) = l.message else { return true };
        let (Some(role), Some(content)) = (m.role.as_deref(), m.content) else { return true };
        if role != "user" && role != "assistant" { return true }
        let t = m.timestamp.or_else(|| l.timestamp.as_deref().and_then(parse_iso_ms));
        if let Some(t) = t {
            self.last_activity_ms = Some(self.last_activity_ms.map_or(t, |p| p.max(t)));
        }
        if role == "user" && self.first_message.is_empty() {
            self.first_message = content_text(content);
        }
        true
    }

    fn summary(&self, path: &str, file_mtime_ms: f64) -> SessionSummary {
        let modified = match self.last_activity_ms {
            Some(t) if t > 0.0 => t,
            _ => self.created_ms.unwrap_or(file_mtime_ms),
        };
        SessionSummary {
            path: path.to_string(),
            id: self.id.clone(),
            cwd: self.cwd.clone(),
            name: self.name.clone(),
            parent_session_path: self.parent_session.clone(),
            version: self.version,
            created_ms: self.created_ms,
            modified_ms: modified,
            message_count: self.message_count,
            first_message: if self.first_message.is_empty() { "(no messages)".into() } else { self.first_message.clone() },
        }
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// Scan `path`, resuming from `prev` when the file only grew. None = not a pi session / unreadable.
pub fn scan_file(path: &Path, prev: Option<&FileIndex>) -> Option<FileIndex> {
    // Unchanged (size, mtime) is answered from the cache without opening the file.
    let meta = std::fs::metadata(path).ok()?;
    let (size, mtime) = (meta.len(), mtime_ms(&meta));
    if let Some(p) = prev {
        if p.size == size && p.mtime_ms == mtime { return Some(p.clone()) }
    }
    let mut f = File::open(path).ok()?;
    let mut head = vec![0u8; HEAD_BYTES.min(size as usize)];
    f.read_exact(&mut head).ok()?;
    let head_hash = fnv(&head);

    let resume = prev.filter(|p| p.head_hash == head_hash && p.scanned_to <= size && p.scanned_to > 0);
    let (mut st, start) = match resume {
        Some(p) => (p.clone(), p.scanned_to),
        None => (FileIndex::default(), 0),
    };
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    f.read_to_end(&mut buf).ok()?;

    let mut first = start == 0;
    let mut pos = 0usize;
    let mut scanned = start;
    while let Some(nl) = buf[pos..].iter().position(|&c| c == b'\n') {
        let line = buf[pos..pos + nl].trim_ascii();
        pos += nl + 1;
        scanned = start + pos as u64;
        if line.is_empty() { continue }
        if !st.apply(line, first) { return None }
        first = false;
    }
    st.size = size;
    st.mtime_ms = mtime;
    st.head_hash = head_hash;
    st.scanned_to = scanned;
    // shortcut: a final line without a newline is ignored (pi always terminates lines); counted once its newline lands.
    if first { return None } // no header line
    Some(st)
}

#[derive(Default, Serialize, Deserialize)]
struct CacheFile { format: u32, files: HashMap<String, FileIndex> }

#[derive(Default)]
pub struct Index {
    files: Mutex<HashMap<String, FileIndex>>,
    cache_path: Option<PathBuf>,
}

impl Index {
    pub fn new(cache_path: Option<PathBuf>) -> Self {
        let files = cache_path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<CacheFile>(&b).ok())
            .filter(|c| c.format == CACHE_FORMAT)
            .map(|c| c.files)
            .unwrap_or_default();
        Index { files: Mutex::new(files), cache_path }
    }

    /// Summaries of every `.jsonl` directly inside `dir`, in parallel, newest activity first.
    pub fn list_dir(&self, dir: &Path) -> Vec<SessionSummary> {
        let paths: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "jsonl")).collect())
            .unwrap_or_default();
        self.list_paths(&paths)
    }

    /// Every session directory one level under `root`.
    pub fn list_root(&self, root: &Path) -> Vec<SessionSummary> {
        let mut paths = vec![];
        for d in std::fs::read_dir(root).into_iter().flatten().flatten() {
            for e in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "jsonl") { paths.push(p) }
            }
        }
        self.list_paths(&paths)
    }

    fn list_paths(&self, paths: &[PathBuf]) -> Vec<SessionSummary> {
        let next = AtomicUsize::new(0);
        let results: Mutex<Vec<(usize, Option<FileIndex>)>> = Mutex::new(vec![]);
        let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8).min(paths.len().max(1));
        // Largest files first so the long scans start early.
        let mut order: Vec<usize> = (0..paths.len()).collect();
        order.sort_by_key(|&i| std::cmp::Reverse(std::fs::metadata(&paths[i]).map_or(0, |m| m.len())));
        std::thread::scope(|s| {
            for _ in 0..workers {
                s.spawn(|| loop {
                    let n = next.fetch_add(1, Ordering::Relaxed);
                    let Some(&i) = order.get(n) else { break };
                    let key = paths[i].to_string_lossy().to_string();
                    let prev = self.files.lock().unwrap().get(&key).cloned();
                    let fresh = scan_file(&paths[i], prev.as_ref());
                    results.lock().unwrap().push((i, fresh));
                });
            }
        });
        let mut dirty = false;
        let mut out = vec![];
        {
            let mut files = self.files.lock().unwrap();
            for (i, fresh) in results.into_inner().unwrap() {
                let key = paths[i].to_string_lossy().to_string();
                match fresh {
                    Some(f) => {
                        let mt = f.mtime_ms;
                        dirty |= files.get(&key).is_none_or(|p| p.size != f.size || p.mtime_ms != f.mtime_ms);
                        out.push(f.summary(&key, mt));
                        files.insert(key, f);
                    }
                    None => dirty |= files.remove(&key).is_some(),
                }
            }
        }
        if dirty { self.save() }
        out.sort_by(|a, b| b.modified_ms.total_cmp(&a.modified_ms));
        out
    }

    fn save(&self) {
        let Some(p) = &self.cache_path else { return };
        let body = {
            let files = self.files.lock().unwrap();
            serde_json::to_vec(&serde_json::json!({ "format": CACHE_FORMAT, "files": &*files }))
        };
        let Ok(body) = body else { return };
        let tmp = p.with_extension("tmp");
        // Best effort: a failed cache write only costs a rescan next start.
        if std::fs::write(&tmp, body).is_ok() { let _ = std::fs::rename(&tmp, p); }
    }
}
