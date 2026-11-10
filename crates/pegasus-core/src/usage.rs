//! Usage index: the entries of every session that carry token usage, without message content.
//! One streaming pass per file (no size cap, no whole-file buffer), cached by (size, mtime) and
//! resumed from the last byte offset when a file only grew. Electron prices and sums the result
//! with the same code it always used, so this only replaces reading and parsing.
use crate::index::{fnv, FileIndex};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use ts_rs::TS;

const CACHE_FORMAT: u32 = 1;
const HEAD_BYTES: usize = 256;

/// A message as usage needs it: who spoke, which model answered, what it cost, how it ended.
#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// pi's usage object, passed through unparsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub usage: Option<Box<RawValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timestamp: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stop_reason: Option<String>,
}

/// A session entry reduced to its usage fields: `usage`, `compaction` and `branch_summary`
/// entries with their usage, and user, assistant and tool-result messages.
#[derive(Clone, Serialize, Deserialize, TS)]
pub struct UsageEntry {
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timestamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub usage: Option<Box<RawValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<UsageMessage>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageSession {
    pub path: String,
    pub id: String,
    pub cwd: String,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// First user message text, "" when there is none (pi's listAll says "(no messages)").
    pub first_message: String,
    pub entries: Vec<UsageEntry>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageScan {
    pub sessions: Vec<UsageSession>,
    /// Session files that could not be read.
    pub unreadable: u32,
}

#[derive(Deserialize)]
struct Line<'a> {
    #[serde(rename = "type", borrow)]
    ty: Option<Cow<'a, str>>,
    #[serde(borrow)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow)]
    usage: Option<&'a RawValue>,
    #[serde(borrow)]
    message: Option<Msg<'a>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Msg<'a> {
    #[serde(borrow)]
    role: Option<Cow<'a, str>>,
    #[serde(borrow)]
    provider: Option<Cow<'a, str>>,
    #[serde(borrow)]
    model: Option<Cow<'a, str>>,
    #[serde(borrow)]
    usage: Option<&'a RawValue>,
    timestamp: Option<f64>,
    #[serde(borrow)]
    stop_reason: Option<Cow<'a, str>>,
}

fn owned(v: Option<&RawValue>) -> Option<Box<RawValue>> {
    v.map(|r| r.to_owned())
}

/// The usage fields of one line, or None when it carries none (malformed lines included, as pi skips them).
fn usage_entry(line: &[u8]) -> Option<UsageEntry> {
    let l: Line = serde_json::from_slice(line).ok()?;
    let ty = l.ty.as_deref()?;
    let timestamp = l.timestamp.map(Cow::into_owned);
    match ty {
        "usage" | "compaction" | "branch_summary" => {
            let usage = owned(l.usage)?;
            Some(UsageEntry { ty: ty.to_string(), timestamp, usage: Some(usage), message: None })
        }
        "message" => {
            let m = l.message?;
            let role = m.role.as_deref()?;
            if role != "user" && role != "assistant" && role != "toolResult" {
                return None;
            }
            // A user turn only marks when a task started; a tool result without usage adds nothing.
            if role == "toolResult" && m.usage.is_none() {
                return None;
            }
            Some(UsageEntry {
                ty: "message".into(),
                timestamp,
                usage: None,
                message: Some(UsageMessage {
                    role: role.to_string(),
                    provider: m.provider.map(Cow::into_owned),
                    model: m.model.map(Cow::into_owned),
                    usage: if role == "user" { None } else { owned(m.usage) },
                    timestamp: m.timestamp,
                    stop_reason: m.stop_reason.map(Cow::into_owned),
                }),
            })
        }
        _ => None,
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct UsageFile {
    size: u64,
    mtime_ms: f64,
    scanned_to: u64,
    head_hash: u64,
    info: FileIndex,
    entries: Vec<UsageEntry>,
}

enum Scan {
    Session(UsageFile),
    NotASession,
    Unreadable,
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn scan_file(path: &Path, prev: Option<&UsageFile>) -> Scan {
    let Ok(meta) = std::fs::metadata(path) else { return Scan::Unreadable };
    let (size, mtime) = (meta.len(), mtime_ms(&meta));
    if let Some(p) = prev {
        if p.size == size && p.mtime_ms == mtime {
            return Scan::Session(p.clone());
        }
    }
    let Ok(mut f) = File::open(path) else { return Scan::Unreadable };
    let mut head = vec![0u8; HEAD_BYTES.min(size as usize)];
    if f.read_exact(&mut head).is_err() {
        return Scan::Unreadable;
    }
    let head_hash = fnv(&head);
    let resume = prev.filter(|p| p.head_hash == head_hash && p.scanned_to <= size && p.scanned_to > 0);
    let (mut st, start) = match resume {
        Some(p) => (p.clone(), p.scanned_to),
        None => (UsageFile::default(), 0),
    };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Scan::Unreadable;
    }
    let mut reader = BufReader::with_capacity(1 << 20, f);
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut first = start == 0;
    let mut scanned = start;
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => return Scan::Unreadable,
        }
        // shortcut: a final line without its newline waits for the next scan, as in the session index.
        if buf.last() != Some(&b'\n') {
            break;
        }
        scanned += buf.len() as u64;
        let line = buf.trim_ascii();
        if line.is_empty() {
            continue;
        }
        if !st.info.apply_line(line, first) {
            return Scan::NotASession;
        }
        first = false;
        if let Some(entry) = usage_entry(line) {
            st.entries.push(entry);
        }
    }
    if first {
        return Scan::NotASession;
    }
    st.size = size;
    st.mtime_ms = mtime;
    st.head_hash = head_hash;
    st.scanned_to = scanned;
    Scan::Session(st)
}

#[derive(Default, Serialize, Deserialize)]
struct CacheFile {
    format: u32,
    files: HashMap<String, UsageFile>,
}

/// Owns its own lock, so a first full scan never blocks the session store.
#[derive(Default)]
pub struct UsageIndex {
    files: Mutex<HashMap<String, UsageFile>>,
    cache_path: Option<PathBuf>,
}

impl UsageIndex {
    pub fn new(cache_path: Option<PathBuf>) -> Self {
        let files = cache_path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<CacheFile>(&b).ok())
            .filter(|c| c.format == CACHE_FORMAT)
            .map(|c| c.files)
            .unwrap_or_default();
        UsageIndex { files: Mutex::new(files), cache_path }
    }

    /// Every session `.jsonl` one directory level under `root`, scanned in parallel.
    pub fn scan_root(&self, root: &Path) -> UsageScan {
        let mut paths = vec![];
        for d in std::fs::read_dir(root).into_iter().flatten().flatten() {
            for e in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "jsonl") {
                    paths.push(p);
                }
            }
        }
        self.scan_paths(&paths)
    }

    fn scan_paths(&self, paths: &[PathBuf]) -> UsageScan {
        let next = AtomicUsize::new(0);
        let results: Mutex<Vec<(usize, Scan)>> = Mutex::new(vec![]);
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
        let mut sessions = vec![];
        let mut unreadable = 0;
        {
            let mut files = self.files.lock().unwrap();
            for (i, fresh) in results.into_inner().unwrap() {
                let key = paths[i].to_string_lossy().to_string();
                match fresh {
                    Scan::Session(f) => {
                        dirty |= files.get(&key).is_none_or(|p| p.size != f.size || p.mtime_ms != f.mtime_ms);
                        sessions.push(UsageSession {
                            path: key.clone(),
                            id: f.info.id.clone(),
                            cwd: f.info.cwd.clone(),
                            name: f.info.name.clone(),
                            first_message: f.info.first_message.clone(),
                            entries: f.entries.clone(),
                        });
                        files.insert(key, f);
                    }
                    Scan::NotASession => dirty |= files.remove(&key).is_some(),
                    Scan::Unreadable => unreadable += 1,
                }
            }
            // Files that were deleted since the last scan.
            let live: std::collections::HashSet<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
            let before = files.len();
            files.retain(|k, _| live.contains(k));
            dirty |= files.len() != before;
        }
        if dirty {
            self.save();
        }
        sessions.sort_by(|a, b| a.path.cmp(&b.path));
        UsageScan { sessions, unreadable }
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
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, lines: &[&str]) {
        let mut f = File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn keeps_only_usage_fields_and_resumes_appends() {
        let dir = std::env::temp_dir().join(format!("pegasus-usage-{}", std::process::id()));
        let sessions = dir.join("--ws--");
        std::fs::create_dir_all(&sessions).unwrap();
        let file = sessions.join("a.jsonl");
        write(
            &file,
            &[
                r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-11-10T10:00:00.000Z","cwd":"D:\\ws"}"#,
                r#"{"type":"message","id":"1","timestamp":"2026-11-10T10:00:01.000Z","message":{"role":"user","content":"Fix the parser","timestamp":1}}"#,
                r#"{"type":"message","id":"2","timestamp":"2026-11-10T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"big"}],"provider":"openai","model":"gpt-6.1-sol","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"total":0.01}},"stopReason":"stop","timestamp":2}}"#,
                r#"{"type":"message","id":"3","timestamp":"2026-11-10T10:00:06.000Z","message":{"role":"toolResult","content":"out"}}"#,
                r#"not json"#,
                r#"{"type":"session_info","name":"Parser"}"#,
            ],
        );
        let index = UsageIndex::new(None);
        let scan = index.scan_root(&dir);
        assert_eq!(scan.unreadable, 0);
        assert_eq!(scan.sessions.len(), 1);
        let s = &scan.sessions[0];
        assert_eq!((s.id.as_str(), s.name.as_deref(), s.first_message.as_str()), ("s1", Some("Parser"), "Fix the parser"));
        let json = serde_json::to_string(&s.entries).unwrap();
        assert_eq!(s.entries.len(), 2, "{json}");
        assert!(!json.contains("big"), "content must not be kept: {json}");
        assert!(json.contains(r#""usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"total":0.01}}"#));
        assert!(json.contains(r#""stopReason":"stop""#));

        // Appending resumes from the stored offset and keeps what was already found.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        writeln!(f, r#"{{"type":"usage","timestamp":"2026-11-10T10:01:00.000Z","usage":{{"input":1,"output":0,"cacheRead":0,"cacheWrite":3}}}}"#).unwrap();
        drop(f);
        let again = index.scan_root(&dir);
        assert_eq!(again.sessions[0].entries.len(), 3);
        assert_eq!(again.sessions[0].entries[2].ty, "usage");

        // A file without a session header is not a session.
        write(&sessions.join("b.jsonl"), &[r#"{"type":"message"}"#]);
        assert_eq!(index.scan_root(&dir).sessions.len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
