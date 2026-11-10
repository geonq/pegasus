//! Reads of one session file: the compaction-aware context path pi renders, slices of it by row,
//! and appended lines since a byte offset. Never writes; entries are returned as the raw JSON
//! lines so the consumer's own projection (TypeScript) sees exactly what pi wrote.
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::ops::Range;
use std::path::Path;

#[derive(Deserialize)]
struct Meta<'a> {
    #[serde(rename = "type", borrow)]
    ty: Option<Cow<'a, str>>,
    #[serde(borrow)]
    id: Option<Cow<'a, str>>,
    #[serde(borrow, rename = "parentId")]
    parent_id: Option<Cow<'a, str>>,
    #[serde(borrow, rename = "firstKeptEntryId")]
    first_kept: Option<Cow<'a, str>>,
    #[serde(borrow, rename = "customType")]
    custom_type: Option<Cow<'a, str>>,
    version: Option<u32>,
    message: Option<RoleOnly<'a>>,
}
#[derive(Deserialize)]
struct RoleOnly<'a> {
    #[serde(borrow)]
    role: Option<Cow<'a, str>>,
}

/// Byte ranges (within `bytes`) of the entries to render, plus pins from the full branch.
pub struct Context {
    pub bytes: Vec<u8>,
    pub entries: Vec<Range<usize>>,
    pub pins: Vec<Range<usize>>,
    pub leaf_id: Option<String>,
    pub version: u32,
}

/// Port of pi's `buildContextEntries(entries, leafId, byId)` for v3 files. Err for older versions
/// (pi migrates and rewrites those; the caller must fall back to pi itself).
pub fn context(path: &Path, pin_type: &str) -> Result<Context, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut lines: Vec<(Range<usize>, Meta)> = vec![];
    let (mut pos, mut version, mut have_header) = (0usize, 0u32, false);
    while pos < bytes.len() {
        let end = bytes[pos..].iter().position(|&c| c == b'\n').map_or(bytes.len(), |n| pos + n);
        let raw = &bytes[pos..end];
        let trimmed = raw.trim_ascii();
        let lead = raw.len() - raw.trim_ascii_start().len();
        let range = pos + lead..pos + lead + trimmed.len();
        pos = end + 1;
        if trimmed.is_empty() { continue }
        let Ok(m) = serde_json::from_slice::<Meta>(&bytes[range.clone()]) else { continue };
        if m.ty.as_deref() == Some("session") {
            if !have_header { version = m.version.unwrap_or(1); have_header = true }
            continue;
        }
        lines.push((range, m));
    }
    if !have_header { return Err("not_a_session".into()) }
    if version < 3 { return Err("unsupported_version".into()) }

    let mut by_id: HashMap<&str, usize> = HashMap::new();
    for (i, (_, m)) in lines.iter().enumerate() {
        if let Some(id) = m.id.as_deref() { by_id.insert(id, i); }
    }
    let leaf_id = lines.last().and_then(|(_, m)| m.id.as_deref());
    // pi: leaf = byId.get(leafId) ?? last entry; then walk parentId to the root.
    let Some(mut cur) = leaf_id.and_then(|id| by_id.get(id).copied()).or(lines.len().checked_sub(1)) else {
        return Ok(Context { bytes, entries: vec![], pins: vec![], leaf_id: None, version });
    };
    let mut path_idx = vec![cur];
    while let Some(p) = lines[cur].1.parent_id.as_deref().filter(|p| !p.is_empty()).and_then(|p| by_id.get(p).copied()) {
        path_idx.push(p);
        cur = p;
        if path_idx.len() > lines.len() { break } // cycle guard
    }
    path_idx.reverse();

    let comp = path_idx.iter().rposition(|&i| lines[i].1.ty.as_deref() == Some("compaction"));
    let mut ctx: Vec<usize> = vec![];
    match comp {
        None => ctx = path_idx.clone(),
        Some(ci) => {
            ctx.push(path_idx[ci]);
            let kept_id = lines[path_idx[ci]].1.first_kept.as_deref();
            let mut found = false;
            for &i in &path_idx[..ci] {
                let m = &lines[i].1;
                if kept_id.is_some() && m.id.as_deref() == kept_id { found = true }
                let system = m.ty.as_deref() == Some("message") && m.message.as_ref().and_then(|x| x.role.as_deref()) == Some("system");
                if found && !system { ctx.push(i) }
            }
            ctx.extend_from_slice(&path_idx[ci + 1..]);
        }
    }
    let pins = path_idx
        .iter()
        .filter(|&&i| lines[i].1.ty.as_deref() == Some("custom") && lines[i].1.custom_type.as_deref() == Some(pin_type))
        .map(|&i| lines[i].0.clone())
        .collect();
    let entries = ctx.iter().map(|&i| lines[i].0.clone()).collect();
    let leaf_id = lines.last().and_then(|(_, m)| m.id.as_deref()).map(str::to_string);
    Ok(Context { bytes, entries, pins, leaf_id, version })
}

pub struct Tail {
    /// Complete, well-formed JSON lines appended since `from`.
    pub lines: Vec<Vec<u8>>,
    pub offset: u64,
    /// The file is shorter than `from` (rewritten): the caller must reload from 0.
    pub reset: bool,
}

/// Lines appended after byte offset `from`. A trailing partial line stays unread (offset stops before it).
pub fn tail(path: &Path, from: u64) -> Result<Tail, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    if from > size { return Ok(Tail { lines: vec![], offset: 0, reset: true }) }
    f.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity((size - from) as usize);
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let complete = buf.iter().rposition(|&c| c == b'\n').map_or(0, |n| n + 1);
    let lines = buf[..complete]
        .split(|&c| c == b'\n')
        .map(<[u8]>::trim_ascii)
        .filter(|l| !l.is_empty() && serde_json::from_slice::<serde::de::IgnoredAny>(l).is_ok())
        .map(<[u8]>::to_vec)
        .collect();
    Ok(Tail { lines, offset: from + complete as u64, reset: false })
}

/// Offset just past the last complete line: where a follower starts. Looks at the last 64 KiB only.
pub fn end_offset(path: &Path) -> Result<u64, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let start = size.saturating_sub(65536);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![];
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(start + buf.iter().rposition(|&c| c == b'\n').map_or(0, |n| n + 1) as u64)
}
