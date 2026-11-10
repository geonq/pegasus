//! Length-prefixed, versioned JSON-RPC over a byte stream: u32 big-endian length, then a UTF-8 JSON
//! body `{"v":1,"id":N,"method":"..","params":{..}}` -> `{"v":1,"id":N,"result":..}` or
//! `{"v":1,"id":N,"error":{"code":"..","message":".."}}`. Every path a client sends must resolve
//! (symlinks followed) inside the sessions root given at start-up.
use crate::{index::Index, session};
use serde::Deserialize;
use std::io::{Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const PROTOCOL: u32 = 1;
/// Requests are tiny; anything bigger is a bug or an attack.
const MAX_REQUEST: usize = 1 << 20;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    v: u32,
    id: u64,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListParams {
    dir: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContextParams {
    path: String,
    pin_type: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SliceParams {
    path: String,
    pin_type: String,
    start: usize,
    count: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TailParams {
    path: String,
    from: Option<u64>,
}

type Fail = (&'static str, String);

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
    serde_json::from_value(v).map_err(|e| ("bad_params", e.to_string()))
}

fn code_of(e: &str) -> &'static str {
    match e {
        "unsupported_version" => "unsupported_version",
        "not_a_session" => "not_a_session",
        _ => "io",
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

fn error_body(id: u64, code: &str, msg: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "v": PROTOCOL, "id": id, "error": { "code": code, "message": msg } })).unwrap()
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

    fn inside(&self, p: &str) -> Result<PathBuf, Fail> {
        if p.contains('\0') {
            return Err(("bad_path", "NUL in path".into()));
        }
        let c = plain(std::fs::canonicalize(p).map_err(|e| ("bad_path", e.to_string()))?);
        if c.starts_with(&self.root) { Ok(c) } else { Err(("outside_root", "path is outside the sessions root".into())) }
    }

    fn file(&self, p: &str) -> Result<PathBuf, Fail> {
        let c = self.inside(p)?;
        if c.extension().is_some_and(|e| e == "jsonl") && c.is_file() { Ok(c) } else { Err(("bad_path", "not a .jsonl file".into())) }
    }

    /// Serves one request body; always returns a response body (errors are responses, not panics).
    pub fn handle(&mut self, body: &[u8]) -> Vec<u8> {
        let req: Request = match serde_json::from_slice(body) {
            Ok(r) => r,
            Err(e) => return error_body(0, "bad_request", &e.to_string()),
        };
        if req.v != PROTOCOL {
            return error_body(req.id, "unsupported_protocol", &format!("server speaks v{PROTOCOL}"));
        }
        match self.dispatch(&req) {
            Ok(result) => {
                let mut out = format!(r#"{{"v":{PROTOCOL},"id":{},"result":"#, req.id).into_bytes();
                out.extend_from_slice(&result);
                out.push(b'}');
                out
            }
            Err((code, msg)) => error_body(req.id, code, &msg),
        }
    }

    fn remember_rows(&mut self, path: &Path, rows: &[Range<usize>]) {
        if let Ok(m) = std::fs::metadata(path) {
            if let Ok(mtime) = m.modified() {
                self.rows = Some(RowCache { path: path.to_path_buf(), size: m.len(), mtime, rows: rows.to_vec() });
            }
        }
    }

    fn dispatch(&mut self, req: &Request) -> Result<Vec<u8>, Fail> {
        let io = |e: std::io::Error| ("io", e.to_string());
        match req.method.as_str() {
            "hello" => Ok(serde_json::to_vec(&serde_json::json!({
                "protocol": PROTOCOL, "name": "pegasus-core", "version": env!("CARGO_PKG_VERSION"),
            }))
            .unwrap()),
            "index.list" => {
                let p: ListParams = parse(&req.params)?;
                let list = match p.dir {
                    Some(d) => {
                        let dir = self.inside(&d)?;
                        if !dir.is_dir() {
                            return Err(("bad_path", "not a directory".into()));
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
                let p: ContextParams = parse(&req.params)?;
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
                let p: SliceParams = parse(&req.params)?;
                let path = self.file(&p.path)?;
                let meta = std::fs::metadata(&path).map_err(io)?;
                let fresh = self.rows.as_ref().is_some_and(|c| {
                    c.path == path && c.size == meta.len() && meta.modified().is_ok_and(|m| m == c.mtime)
                });
                if !fresh {
                    let c = session::context(&path, &p.pin_type).map_err(|e| (code_of(&e), e))?;
                    self.remember_rows(&path, &c.entries);
                }
                let rows = &self.rows.as_ref().ok_or(("io", "row cache unavailable".to_string()))?.rows;
                let start = p.start.min(rows.len());
                let end = start.saturating_add(p.count).min(rows.len());
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
                let p: TailParams = parse(&req.params)?;
                let path = self.file(&p.path)?;
                let t = match p.from {
                    // No offset: start following at the end; nothing to replay.
                    None => session::Tail { lines: vec![], offset: session::end_offset(&path).map_err(|e| ("io", e))?, reset: false },
                    Some(from) => session::tail(&path, from).map_err(|e| ("io", e))?,
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
            other => Err(("unknown_method", other.to_string())),
        }
    }

    /// Blocking request loop; returns on EOF (the parent exited) or a transport error.
    pub fn serve(&mut self, mut r: impl Read, mut w: impl Write) -> std::io::Result<()> {
        loop {
            let mut len = [0u8; 4];
            match r.read_exact(&mut len) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(e) => return Err(e),
            }
            let n = u32::from_be_bytes(len) as usize;
            if n > MAX_REQUEST {
                return Err(std::io::Error::other("request frame too large"));
            }
            let mut body = vec![0u8; n];
            r.read_exact(&mut body)?;
            let resp = self.handle(&body);
            w.write_all(&(resp.len() as u32).to_be_bytes())?;
            w.write_all(&resp)?;
            w.flush()?;
        }
    }
}
