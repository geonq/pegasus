//! Session methods of the host protocol (see `protocol`). Results are JSON bodies built from byte
//! ranges of pi's own lines, so entries are passed through unparsed. Every path a client sends must
//! resolve (symlinks followed) inside the sessions root given at start-up.
use crate::protocol::{ContextParams, ErrorCode, ListParams, SliceParams, TailParams};
use crate::{index::Index, session};
use std::io::{Read, Seek, SeekFrom};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::SystemTime;


pub type Fail = (ErrorCode, String);

/// `\\?\D:\x` -> `D:\x` so canonical paths compare with the plain ones callers use.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

fn parse<T: serde::de::DeserializeOwned>(v: &serde_json::Value) -> Result<T, Fail> {
    let v = if v.is_null() { serde_json::json!({}) } else { v.clone() };
    serde_json::from_value(v).map_err(|e| (ErrorCode::BadParams, e.to_string()))
}

fn code_of(e: &str) -> ErrorCode {
    match e {
        "unsupported_version" => ErrorCode::UnsupportedVersion,
        "not_a_session" => ErrorCode::NotASession,
        _ => ErrorCode::Io,
    }
}

fn join_ranges(out: &mut Vec<u8>, bytes: &[u8], ranges: &[Range<usize>]) {
    for (n, r) in ranges.iter().enumerate() {
        if n > 0 {
            out.push(b',')
        }
        out.extend_from_slice(&bytes[r.start..r.end]);
    }
}

struct RowCache {
    path: PathBuf,
    size: u64,
    mtime: SystemTime,
    rows: Vec<Range<usize>>,
}

pub struct Server {
    root: PathBuf,
    index: Index,
    /// Context row byte ranges of the most recently read file.
    rows: Option<RowCache>,
}

impl Server {
    pub fn new(root: &Path, cache: Option<PathBuf>) -> std::io::Result<Self> {
        Ok(Server { root: plain(std::fs::canonicalize(root)?), index: Index::new(cache), rows: None })
    }

    /// The canonical sessions root every path must resolve inside.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn inside(&self, p: &str) -> Result<PathBuf, Fail> {
        if p.contains('\0') {
            return Err((ErrorCode::BadPath, "NUL in path".into()));
        }
        let c = plain(std::fs::canonicalize(p).map_err(|e| (ErrorCode::BadPath, e.to_string()))?);
        if c.starts_with(&self.root) { Ok(c) } else { Err((ErrorCode::OutsideRoot, "path is outside the sessions root".into())) }
    }

    fn file(&self, p: &str) -> Result<PathBuf, Fail> {
        let c = self.inside(p)?;
        if c.extension().is_some_and(|e| e == "jsonl") && c.is_file() { Ok(c) } else { Err((ErrorCode::BadPath, "not a .jsonl file".into())) }
    }

    fn remember_rows(&mut self, path: &Path, rows: &[Range<usize>]) {
        if let Ok(m) = std::fs::metadata(path) {
            if let Ok(mtime) = m.modified() {
                self.rows = Some(RowCache { path: path.to_path_buf(), size: m.len(), mtime, rows: rows.to_vec() });
            }
        }
    }

    /// Runs one session method; `Ok` is the JSON result body (entries are pi's lines, copied byte for byte).
    pub fn call(&mut self, method: &str, params: &serde_json::Value) -> Result<Vec<u8>, Fail> {
        let io = |e: std::io::Error| (ErrorCode::Io, e.to_string());
        match method {
            "index.list" => {
                let p: ListParams = parse(params)?;
                let list = match p.dir {
                    Some(d) => {
                        let dir = self.inside(&d)?;
                        if !dir.is_dir() {
                            return Err((ErrorCode::BadPath, "not a directory".into()));
                        }
                        let mut l = self.index.list_dir(&dir);
                        // Report paths in the spelling the caller used for the directory.
                        for s in &mut l {
                            if let Some(name) = Path::new(&s.path).file_name() {
                                s.path = Path::new(&d).join(name).to_string_lossy().into_owned();
                            }
                        }
                        l
                    }
                    None => self.index.list_root(&self.root),
                };
                Ok(serde_json::to_vec(&serde_json::json!({ "sessions": list })).unwrap())
            }
            "session.context" => {
                let p: ContextParams = parse(params)?;
                let path = self.file(&p.path)?;
                let c = session::context(&path, &p.pin_type).map_err(|e| (code_of(&e), e))?;
                self.remember_rows(&path, &c.entries);
                let mut out = format!(
                    r#"{{"total":{},"version":{},"leafId":{},"entries":["#,
                    c.entries.len(),
                    c.version,
                    serde_json::to_string(&c.leaf_id).unwrap()
                )
                .into_bytes();
                join_ranges(&mut out, &c.bytes, &c.entries);
                out.extend_from_slice(br#"],"pins":["#);
                join_ranges(&mut out, &c.bytes, &c.pins);
                out.extend_from_slice(b"]}");
                Ok(out)
            }
            "session.slice" => {
                let p: SliceParams = parse(params)?;
                let path = self.file(&p.path)?;
                let meta = std::fs::metadata(&path).map_err(io)?;
                let fresh = self.rows.as_ref().is_some_and(|c| {
                    c.path == path && c.size == meta.len() && meta.modified().is_ok_and(|m| m == c.mtime)
                });
                if !fresh {
                    let c = session::context(&path, &p.pin_type).map_err(|e| (code_of(&e), e))?;
                    self.remember_rows(&path, &c.entries);
                }
                let rows = &self.rows.as_ref().ok_or((ErrorCode::Io, "row cache unavailable".to_string()))?.rows;
                let start = (p.start as usize).min(rows.len());
                let end = start.saturating_add(p.count as usize).min(rows.len());
                let mut f = std::fs::File::open(&path).map_err(io)?;
                let mut out = format!(r#"{{"total":{},"start":{},"entries":["#, rows.len(), start).into_bytes();
                for (n, r) in rows[start..end].iter().enumerate() {
                    if n > 0 {
                        out.push(b',');
                    }
                    f.seek(SeekFrom::Start(r.start as u64)).map_err(io)?;
                    let mut line = vec![0u8; r.len()];
                    f.read_exact(&mut line).map_err(io)?;
                    out.extend_from_slice(&line);
                }
                out.extend_from_slice(b"]}");
                Ok(out)
            }
            "session.tail" => {
                let p: TailParams = parse(params)?;
                let path = self.file(&p.path)?;
                let t = match p.from {
                    // No offset: start following at the end; nothing to replay.
                    None => session::Tail { lines: vec![], offset: session::end_offset(&path).map_err(|e| (ErrorCode::Io, e))?, reset: false },
                    Some(from) => session::tail(&path, from).map_err(|e| (ErrorCode::Io, e))?,
                };
                let mut out = format!(r#"{{"offset":{},"reset":{},"lines":["#, t.offset, t.reset).into_bytes();
                for (n, l) in t.lines.iter().enumerate() {
                    if n > 0 {
                        out.push(b',');
                    }
                    out.extend_from_slice(l);
                }
                out.extend_from_slice(b"]}");
                Ok(out)
            }
            other => Err((ErrorCode::UnknownMethod, other.to_string())),
        }
    }
}
