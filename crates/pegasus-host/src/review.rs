//! Git review, ported from apps/desktop/electron/platform/files/git-review.ts. Same Git commands and
//! semantics (raw bytes, no filters, literal pathspecs, isolated GIT_* environment), but parsing and
//! hashing run here instead of on Electron's main thread, and independent Git calls run in parallel.
//! Every outcome a user can see is a typed `ReviewIssue`; nothing is swallowed.
use pegasus_core::review_types::*;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_FILES: usize = 2_000;
const MAX_CONTENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PATCH_BYTES: u64 = 1024 * 1024;
const MAX_GIT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PREPARATION_BYTES: u64 = 32 * 1024 * 1024;
const PREPARATION: Duration = Duration::from_secs(10);
/// Pathspec bytes per Git call, well below Windows' 32K command-line limit.
const MAX_PATHSPEC_BYTES: usize = 24_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// Above this many paths, try one full (capped) listing before pathspec batches.
const FULL_LISTING_MIN_PATHS: usize = 200;
const FULL_LISTING_MAX_BYTES: u64 = 4 * 1024 * 1024;

type R<T> = Result<T, String>;

// ---------- git ----------

struct GitResult {
    stdout: Vec<u8>,
    code: i32,
    truncated: bool,
}

/// One Git invocation. Exit 0/1 are results (diff and status use 1); >1 is an error with stderr.
/// Output past `max` stops the command and reports `truncated`, like Node's maxBuffer.
fn git(cwd: &Path, args: &[&str], max: u64) -> R<GitResult> {
    let mut cmd = Command::new("git");
    cmd.args(["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false"])
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Inherited GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE would redirect the command away from the checkout.
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(k);
        }
    }
    cmd.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: the host has no console to share
    }
    let mut child = cmd.spawn().map_err(|e| format!("git could not start: {e}"))?;
    let mut out = child.stdout.take().ok_or("git stdout unavailable")?;
    let mut err = child.stderr.take().ok_or("git stderr unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let n = (&mut out).take(max + 1).read_to_end(&mut buf);
        (buf, n.is_ok())
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut err).take(64 * 1024).read_to_end(&mut buf);
        buf
    });
    let started = Instant::now();
    let status = loop {
        if reader.is_finished() {
            // Over the cap: stop git instead of waiting for output nobody will read.
            break child.wait().map_err(|e| e.to_string())?;
        }
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if started.elapsed() > GIT_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("git {} timed out after {} s", args.first().unwrap_or(&""), GIT_TIMEOUT.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    let (mut stdout, _) = reader.join().map_err(|_| "git reader panicked")?;
    let stderr = err_reader.join().unwrap_or_default();
    if stdout.len() as u64 > max {
        stdout.truncate(max as usize);
        let _ = child.kill();
        return Ok(GitResult { stdout, code: 1, truncated: true });
    }
    let code = status.code().unwrap_or(128);
    if code > 1 {
        let msg = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if msg.is_empty() { "Git command failed.".into() } else { msg });
    }
    Ok(GitResult { stdout, code, truncated: false })
}

fn git_text(cwd: &Path, args: &[&str], max: u64) -> R<String> {
    let r = git(cwd, args, max)?;
    if r.code != 0 || r.truncated {
        return Err("Git review data is unavailable or exceeds its size limit.".into());
    }
    Ok(String::from_utf8_lossy(&r.stdout).into_owned())
}

fn resolve_revision(cwd: &Path, rev: &str, kind: &str) -> Option<String> {
    let spec = format!("{rev}^{{{kind}}}");
    git_text(cwd, &["rev-parse", "--verify", "--end-of-options", &spec], MAX_GIT_BYTES)
        .ok()
        .map(|s| s.trim().to_string())
}

// ---------- helpers ----------

fn issue(state: IssueState, code: &str, message: impl Into<String>) -> ReviewIssue {
    ReviewIssue::new(state, code, message)
}

pub fn digest(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex(&h.finalize())
}

fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

/// `resolve(root, path)` that refuses anything escaping `root` (absolute, `..`, NUL, empty).
fn safe_path(root: &Path, path: &str) -> R<PathBuf> {
    let bad = || Err("Invalid Git file path.".to_string());
    if path.is_empty() || path.contains('\0') || path.starts_with('/') || path.starts_with('\\') {
        return bad();
    }
    let p = Path::new(path);
    if p.is_absolute() || p.has_root() || matches!(p.components().next(), Some(Component::Prefix(_))) {
        return bad();
    }
    let mut depth: i64 = 0;
    for part in path.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return bad();
                }
            }
            _ => depth += 1,
        }
    }
    if depth == 0 {
        return bad();
    }
    Ok(root.join(path))
}

struct WorkingFile {
    mode: String,
    digest: String,
    bytes: Option<Vec<u8>>,
    note: Option<String>,
}

impl WorkingFile {
    fn missing() -> Self {
        WorkingFile { mode: "missing".into(), digest: "missing".into(), bytes: None, note: None }
    }
    fn state(&self) -> WorkingState {
        WorkingState { mode: self.mode.clone(), digest: self.digest.clone(), note: self.note.clone() }
    }
}

fn is_missing(e: &std::io::Error) -> bool {
    // ENOTDIR (a file where a directory was expected) reads as missing too.
    e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(20) || e.raw_os_error() == Some(267)
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

#[cfg(unix)]
fn change_ms(m: &std::fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    m.ctime() as f64 * 1000.0 + (m.ctime_nsec() as f64 / 1e6)
}
#[cfg(not(unix))]
fn change_ms(m: &std::fs::Metadata) -> f64 {
    ms(m.created())
}

#[cfg(unix)]
fn ino(m: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(m)
}
#[cfg(not(unix))]
fn ino(_: &std::fs::Metadata) -> u64 {
    0
}

#[cfg(unix)]
fn executable(m: &std::fs::Metadata) -> bool {
    std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0
}
/// Node reports Windows files as 0o100666, so they are never executable there.
#[cfg(not(unix))]
fn executable(_: &std::fs::Metadata) -> bool {
    false
}

fn read_working_file(root: &Path, path: &str, max_bytes: u64) -> R<WorkingFile> {
    let absolute = safe_path(root, path)?;
    // A replaced ancestor must not redirect a review read outside the checkout.
    let segments: Vec<&str> = path.split('/').collect();
    for i in 1..segments.len() {
        let ancestor = segments[..i].iter().fold(root.to_path_buf(), |p, s| p.join(s));
        match std::fs::symlink_metadata(&ancestor) {
            Ok(m) if m.file_type().is_symlink() => {
                return Ok(WorkingFile {
                    mode: "unsupported".into(),
                    digest: "symlink-parent".into(),
                    bytes: None,
                    note: Some("A parent directory is a symbolic link; content was not followed.".into()),
                });
            }
            Ok(_) => {}
            Err(e) if is_missing(&e) => return Ok(WorkingFile::missing()),
            Err(e) => return Err(e.to_string()),
        }
    }
    let before = match std::fs::symlink_metadata(&absolute) {
        Ok(m) => m,
        Err(e) if is_missing(&e) => return Ok(WorkingFile::missing()),
        Err(e) => return Err(e.to_string()),
    };
    let stamp = |m: &std::fs::Metadata| format!("{}:{}", ms(m.modified()), change_ms(m));
    if before.is_dir() {
        return Ok(WorkingFile {
            mode: "160000".into(),
            digest: stamp(&before),
            bytes: None,
            note: Some("Submodule or directory content is not included in this patch.".into()),
        });
    }
    let link = before.file_type().is_symlink();
    let mode = if link { "120000" } else if executable(&before) { "100755" } else { "100644" }.to_string();
    if !link && !before.is_file() {
        return Ok(WorkingFile {
            mode: "unsupported".into(),
            digest: "special-file".into(),
            bytes: None,
            note: Some("Special file content is not supported.".into()),
        });
    }
    if before.len() > max_bytes {
        return Ok(WorkingFile {
            mode,
            digest: format!("large:{}:{}", before.len(), stamp(&before)),
            bytes: None,
            note: Some(if before.len() > MAX_CONTENT_BYTES {
                "File exceeds the 8 MiB review content limit.".into()
            } else {
                "File content was omitted because review preparation reached its byte or time budget.".into()
            }),
        });
    }
    let bytes = if link {
        std::fs::read_link(&absolute).map(|t| t.to_string_lossy().into_owned().into_bytes())
    } else {
        std::fs::read(&absolute)
    };
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) if is_missing(&e) => return Ok(WorkingFile::missing()),
        Err(e) => return Err(e.to_string()),
    };
    let after = std::fs::symlink_metadata(&absolute).map_err(|e| e.to_string())?;
    if ino(&before) != ino(&after)
        || before.len() != after.len()
        || ms(before.modified()) != ms(after.modified())
        || change_ms(&before) != change_ms(&after)
    {
        return Err("File changed while its review snapshot was being read.".into());
    }
    Ok(WorkingFile { mode, digest: digest(&bytes), bytes: Some(bytes), note: None })
}

fn parse_blobs(output: &str, index: bool) -> R<HashMap<String, Vec<BlobRef>>> {
    let mut blobs: HashMap<String, Vec<BlobRef>> = HashMap::new();
    for record in output.split('\0') {
        if record.is_empty() {
            continue;
        }
        let tab = record.find('\t').ok_or("Invalid Git blob listing.")?;
        let path = &record[tab + 1..];
        let fields: Vec<&str> = record[..tab].split(' ').collect();
        let mode = fields.first().copied().unwrap_or("");
        let oid = fields.get(if index { 1 } else { 2 }).copied().unwrap_or("");
        if mode.is_empty() || oid.is_empty() {
            return Err("Invalid Git blob listing.".into());
        }
        let stage = if index { Some(fields.get(2).and_then(|s| s.parse().ok()).unwrap_or(0)) } else { None };
        blobs.entry(path.to_string()).or_default().push(BlobRef { mode: mode.into(), oid: oid.into(), stage });
    }
    Ok(blobs)
}

/// Splits pathspecs into command-line-sized batches (de-duplicated, first-seen order).
fn path_batches<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<Vec<&'a str>> {
    let mut seen = HashSet::new();
    let mut batches: Vec<Vec<&str>> = vec![];
    let mut batch: Vec<&str> = vec![];
    let mut bytes = 0;
    for p in paths {
        if !seen.insert(p) {
            continue;
        }
        let size = p.len() + 1;
        if !batch.is_empty() && bytes + size > MAX_PATHSPEC_BYTES {
            batches.push(std::mem::take(&mut batch));
            bytes = 0;
        }
        batch.push(p);
        bytes += size;
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    batches
}

/// Lists only the named paths, so the cost follows the change set, not the repository size.
fn list_blobs<'a>(
    cwd: &Path,
    command: &[&str],
    paths: impl IntoIterator<Item = &'a str>,
    index: bool,
    max: u64,
) -> R<HashMap<String, Vec<BlobRef>>> {
    let paths: Vec<&str> = paths.into_iter().collect();
    // Many paths: one full listing filtered here beats many pathspec batches (each one makes Git
    // match every entry against hundreds of specs), as long as the listing stays small. A large
    // repository overruns the cap and falls back to batches, so cost still follows the change set.
    if paths.len() > FULL_LISTING_MIN_PATHS {
        if let Ok(r) = git(cwd, command, max.min(FULL_LISTING_MAX_BYTES)) {
            if r.code == 0 && !r.truncated {
                let wanted: HashSet<&str> = paths.iter().copied().collect();
                let mut all = parse_blobs(&String::from_utf8_lossy(&r.stdout), index)?;
                all.retain(|p, _| wanted.contains(p.as_str()));
                return Ok(all);
            }
        }
    }
    // Batches are independent Git calls; run them side by side.
    let batches = path_batches(paths.iter().copied());
    let results: Vec<R<HashMap<String, Vec<BlobRef>>>> = std::thread::scope(|s| {
        let handles: Vec<_> = batches
            .into_iter()
            .map(|batch| {
                s.spawn(move || {
                    let mut args: Vec<&str> = command.to_vec();
                    args.push("--");
                    args.extend(batch);
                    parse_blobs(&git_text(cwd, &args, max)?, index)
                })
            })
            .collect();
        handles.into_iter().map(join).collect()
    });
    let mut out = HashMap::new();
    for r in results {
        out.extend(r?);
    }
    Ok(out)
}

fn tree<'a>(cwd: &Path, oid: Option<&str>, paths: impl IntoIterator<Item = &'a str>, max: u64) -> R<HashMap<String, Vec<BlobRef>>> {
    match oid {
        Some(oid) => list_blobs(cwd, &["ls-tree", "-r", "-z", oid], paths, false, max),
        None => Ok(HashMap::new()),
    }
}

#[derive(Clone)]
struct StatusFile {
    path: String,
    previous_path: Option<String>,
    status: ReviewFileStatus,
    has_staged: bool,
    has_unstaged: bool,
    conflicted: bool,
    records: Vec<String>,
}

fn parse_status(output: &str) -> R<Vec<StatusFile>> {
    let records: Vec<&str> = output.split('\0').collect();
    let mut order: Vec<String> = vec![];
    let mut files: HashMap<String, StatusFile> = HashMap::new();
    let mut i = 0;
    while i < records.len() {
        let record = records[i];
        i += 1;
        if record.is_empty() {
            continue;
        }
        let b = record.as_bytes();
        if b.len() < 4 || b[2] != b' ' {
            return Err("Invalid Git status.".into());
        }
        let xy = &record[..2];
        let path = record[3..].to_string();
        let previous_path = if xy.contains(['R', 'C']) {
            let p = records.get(i).map(|s| s.to_string());
            i += 1;
            p
        } else {
            None
        };
        let conflicted = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].contains(&xy);
        let status = if conflicted {
            ReviewFileStatus::Conflicted
        } else if xy == "??" {
            ReviewFileStatus::Untracked
        } else if xy.contains('R') {
            ReviewFileStatus::Renamed
        } else if xy.contains('C') {
            ReviewFileStatus::Copied
        } else if xy.contains('T') {
            ReviewFileStatus::Typechanged
        } else if xy.contains('A') {
            ReviewFileStatus::Added
        } else if xy.contains('D') {
            ReviewFileStatus::Deleted
        } else {
            ReviewFileStatus::Modified
        };
        let x = b[0];
        let y = b[1];
        let prior = files.get(&path).cloned();
        if prior.is_none() {
            order.push(path.clone());
        }
        let mut recs = prior.as_ref().map(|p| p.records.clone()).unwrap_or_default();
        recs.push(record.to_string());
        if let Some(pp) = &previous_path {
            recs.push(pp.clone());
        }
        let entry = StatusFile {
            path: path.clone(),
            // Like the TS spread: only this record's rename source is kept.
            previous_path: previous_path.clone(),
            status: if prior.is_some() { ReviewFileStatus::Modified } else { status },
            has_staged: prior.as_ref().is_some_and(|p| p.has_staged) || (x != b' ' && x != b'?'),
            has_unstaged: prior.as_ref().is_some_and(|p| p.has_unstaged) || y != b' ',
            conflicted: prior.as_ref().is_some_and(|p| p.conflicted) || conflicted,
            records: recs,
        };
        files.insert(path, entry);
    }
    Ok(order.into_iter().filter_map(|p| files.remove(&p)).collect())
}

// ---------- fingerprints (sha256 of JSON in the TS key order) ----------

#[derive(serde::Serialize)]
struct Identity<'a> {
    mode: &'a str,
    digest: &'a str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FullFp<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    base: Option<&'a BlobRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    head: Option<&'a BlobRef>,
    index: &'a [BlobRef],
    #[serde(skip_serializing_if = "Option::is_none")]
    working: Option<Identity<'a>>,
    status_records: &'a [String],
}

#[derive(serde::Serialize)]
struct StagedFp<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    base: Option<&'a BlobRef>,
    index: &'a [BlobRef],
}

fn identity(w: &Option<WorkingState>) -> Option<Identity<'_>> {
    w.as_ref().map(|w| Identity { mode: &w.mode, digest: &w.digest })
}

fn json_digest<T: serde::Serialize>(v: &T) -> String {
    digest(&serde_json::to_vec(v).unwrap_or_default())
}

fn fingerprint(source: &FileSource, staged: bool) -> String {
    if staged {
        return json_digest(&StagedFp { base: source.base.as_ref(), index: &source.index });
    }
    json_digest(&FullFp {
        base: source.base.as_ref(),
        head: source.head.as_ref(),
        index: &source.index,
        working: identity(&source.working),
        status_records: &source.status_records,
    })
}

fn content_fingerprint(source: &FileSource, kind: &ScopeKind) -> String {
    #[derive(serde::Serialize)]
    struct Staged<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        base: Option<&'a BlobRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        index: Option<&'a BlobRef>,
    }
    #[derive(serde::Serialize)]
    struct Unstaged<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        index: Option<&'a BlobRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        working: Option<Identity<'a>>,
    }
    #[derive(serde::Serialize)]
    struct Other<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        base: Option<&'a BlobRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        head: Option<&'a BlobRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        working: Option<Identity<'a>>,
    }
    let index = source.index.iter().find(|b| b.stage == Some(0));
    match kind {
        ScopeKind::Working(WorkingKind::Staged) => json_digest(&Staged { base: source.base.as_ref(), index }),
        ScopeKind::Working(WorkingKind::Unstaged) => json_digest(&Unstaged { index, working: identity(&source.working) }),
        _ => json_digest(&Other { base: source.base.as_ref(), head: source.head.as_ref(), working: identity(&source.working) }),
    }
}

enum ScopeKind {
    Working(WorkingKind),
    Other,
}

// ---------- create ----------

fn default_base(cwd: &Path) -> R<Option<String>> {
    let branch = git_text(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], MAX_GIT_BYTES)
        .unwrap_or_default()
        .trim()
        .to_string();
    let remote = if branch.is_empty() {
        String::new()
    } else {
        git_text(cwd, &["config", "--get", &format!("branch.{branch}.remote")], MAX_GIT_BYTES)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let heads_out = git_text(cwd, &["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes"], MAX_GIT_BYTES)?;
    let heads: Vec<&str> = heads_out.split('\n').filter(|l| l.contains("/HEAD ")).collect();
    let preferred = heads.iter().find(|l| l.starts_with(&format!("refs/remotes/{remote}/HEAD "))).copied();
    let chosen = preferred.or(if heads.len() == 1 { Some(heads[0]) } else { None });
    if let Some(line) = chosen {
        let target = line[line.find(' ').map_or(line.len(), |i| i + 1)..].trim();
        return Ok(if target.is_empty() { None } else { Some(target.to_string()) });
    }
    if !branch.is_empty() {
        let upstream = git_text(cwd, &["rev-parse", "--symbolic-full-name", "@{upstream}"], MAX_GIT_BYTES)
            .unwrap_or_default()
            .trim()
            .to_string();
        if !upstream.is_empty() {
            return Ok(Some(upstream));
        }
    }
    // No tracking branch: fall back to the conventional trunk, so Branch still opens on something.
    for candidate in ["origin/main", "origin/master", "main", "master"] {
        if candidate == branch {
            continue;
        }
        let full = git_text(cwd, &["rev-parse", "--symbolic-full-name", candidate], MAX_GIT_BYTES)
            .unwrap_or_default()
            .trim()
            .to_string();
        if !full.is_empty() {
            return Ok(Some(full));
        }
    }
    Ok(None)
}

/// `refs/remotes/origin/main` -> `origin/main`.
pub fn short_ref_name(r: &str) -> String {
    for p in ["refs/heads/", "refs/remotes/", "refs/tags/"] {
        if let Some(rest) = r.strip_prefix(p) {
            return rest.to_string();
        }
    }
    r.to_string()
}

fn list_base_options(cwd: &Path, current: &str, chosen: &str) -> Vec<ReviewBaseOption> {
    let refs = git_text(
        cwd,
        &["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"],
        MAX_GIT_BYTES,
    )
    .unwrap_or_default();
    let mut seen = HashSet::new();
    std::iter::once(chosen.to_string())
        .chain(
            refs.split('\n')
                .map(str::trim)
                .filter(|r| !r.is_empty() && !r.ends_with("/HEAD") && short_ref_name(r) != current)
                .map(str::to_string),
        )
        .filter(|r| seen.insert(r.clone()))
        .take(100)
        .map(|r| ReviewBaseOption { label: short_ref_name(&r), ref_name: r })
        .collect()
}

fn numstat(cwd: &Path, comparison: &[&str], max: u64) -> R<Vec<TurnChangedFile>> {
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--find-renames"];
    args.extend_from_slice(comparison);
    args.push("--");
    let out = git_text(cwd, &args, max)?;
    let records: Vec<&str> = out.split('\0').collect();
    let mut files = vec![];
    let mut i = 0;
    while i < records.len() && files.len() < MAX_FILES {
        let record = records[i];
        i += 1;
        if record.is_empty() {
            continue;
        }
        // With -z paths are not quoted, so a path may itself contain tabs.
        let bad = || "Invalid Git change summary.".to_string();
        let a_end = record.find('\t').ok_or_else(bad)?;
        let r_end = record[a_end + 1..].find('\t').map(|j| a_end + 1 + j).ok_or_else(bad)?;
        let added = &record[..a_end];
        let removed = &record[a_end + 1..r_end];
        let inline = &record[r_end + 1..];
        // A rename leaves the inline path empty and lists the old and new paths next.
        let (previous_path, path) = if inline.is_empty() {
            let prev = records.get(i).copied().unwrap_or("");
            let next = records.get(i + 1).copied().unwrap_or("");
            i += 2;
            (Some(prev.to_string()), next.to_string())
        } else {
            (None, inline.to_string())
        };
        if path.is_empty() || previous_path.as_deref() == Some("") {
            return Err(bad());
        }
        let lines = if added == "-" || removed == "-" {
            None
        } else {
            Some(ReviewLineCounts { added: added.parse().map_err(|_| bad())?, removed: removed.parse().map_err(|_| bad())? })
        };
        files.push(TurnChangedFile { path, previous_path, lines });
    }
    Ok(files)
}

fn empty_tree(cwd: &Path) -> R<&'static str> {
    let format = git_text(cwd, &["rev-parse", "--show-object-format"], MAX_GIT_BYTES)?;
    Ok(if format.trim() == "sha256" {
        "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
    } else {
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    })
}

struct LineCounts {
    map: HashMap<String, Option<ReviewLineCounts>>,
    truncated: bool,
}

fn working_line_counts(cwd: &Path, kind: WorkingKind, head: Option<&str>, max: u64) -> R<LineCounts> {
    let files = match kind {
        WorkingKind::Staged => numstat(cwd, &["--cached"], max)?,
        WorkingKind::Unstaged => numstat(cwd, &[], max)?,
        // Before the first commit, Uncommitted compares Git's built-in empty tree with the working tree.
        WorkingKind::Uncommitted => {
            let base = match head {
                Some(h) => h.to_string(),
                None => empty_tree(cwd)?.to_string(),
            };
            numstat(cwd, &[&base], max)?
        }
    };
    let truncated = files.len() >= MAX_FILES;
    Ok(LineCounts { map: files.into_iter().map(|f| (f.path, f.lines)).collect(), truncated })
}

fn status_code(c: u8) -> Option<ReviewFileStatus> {
    Some(match c {
        b'M' => ReviewFileStatus::Modified,
        b'A' => ReviewFileStatus::Added,
        b'D' => ReviewFileStatus::Deleted,
        b'R' => ReviewFileStatus::Renamed,
        b'C' => ReviewFileStatus::Copied,
        b'T' => ReviewFileStatus::Typechanged,
        b'?' => ReviewFileStatus::Untracked,
        _ => return None,
    })
}

/// Staged and Unstaged report their own side: Git's X column for the index, Y for the working tree.
fn scoped_status(entry: &StatusFile, kind: WorkingKind) -> ReviewFileStatus {
    if kind == WorkingKind::Uncommitted || entry.conflicted {
        return entry.status;
    }
    let column = if kind == WorkingKind::Staged { 0 } else { 1 };
    entry
        .records
        .iter()
        .filter(|r| r.len() > 3 && r.as_bytes()[2] == b' ')
        .map(|r| r.as_bytes()[column])
        .find(|&c| c != b' ' && (kind != WorkingKind::Staged || c != b'?'))
        .and_then(status_code)
        .unwrap_or(entry.status)
}

fn count_text_lines(bytes: Option<&[u8]>) -> Option<ReviewLineCounts> {
    let b = bytes?;
    if b[..b.len().min(8000)].contains(&0) {
        return None;
    }
    if b.is_empty() {
        return Some(ReviewLineCounts { added: 0, removed: 0 });
    }
    let mut added = b.iter().filter(|&&c| c == b'\n').count() as u64;
    if b[b.len() - 1] != b'\n' {
        added += 1;
    }
    Some(ReviewLineCounts { added, removed: 0 })
}

fn working_base_label(kind: WorkingKind, has_head: bool) -> String {
    let head = if has_head { "HEAD" } else { "Empty repository" };
    match kind {
        WorkingKind::Staged => format!("{head} → index"),
        WorkingKind::Unstaged => "Index → working tree".into(),
        WorkingKind::Uncommitted => format!("{head} → working tree"),
    }
}

fn realpath(p: &Path) -> R<PathBuf> {
    let c = std::fs::canonicalize(p).map_err(|e| e.to_string())?;
    let s = c.to_string_lossy();
    Ok(match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => c,
    })
}

pub fn create(p: ReviewCreateParams) -> ReviewCreateResult {
    match create_inner(&p) {
        Ok(ReviewCreateResult::Available(mut snapshot)) => {
            snapshot.id = remember(&snapshot);
            ReviewCreateResult::Available(snapshot)
        }
        Ok(r) => r,
        Err(e) => ReviewCreateResult::Issue(issue(IssueState::Unavailable, "git-review-unavailable", e)),
    }
}

/// Recent snapshots, newest last. File operations name one by id instead of resending it.
const KEPT_SNAPSHOTS: usize = 32;
static SNAPSHOTS: std::sync::Mutex<Vec<(String, std::sync::Arc<GitReviewSnapshot>)>> = std::sync::Mutex::new(Vec::new());

fn remember(snapshot: &GitReviewSnapshot) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let seed = format!("{}:{}:{:?}", std::process::id(), N.fetch_add(1, Ordering::Relaxed), std::time::SystemTime::now());
    let id = digest(seed.as_bytes())[..24].to_string();
    let mut kept = SNAPSHOTS.lock().unwrap_or_else(|p| p.into_inner());
    let mut stored = snapshot.clone();
    stored.id = id.clone();
    kept.push((id.clone(), std::sync::Arc::new(stored)));
    let excess = kept.len().saturating_sub(KEPT_SNAPSHOTS);
    kept.drain(..excess);
    id
}

pub fn snapshot(id: &str) -> Result<std::sync::Arc<GitReviewSnapshot>, ReviewIssue> {
    SNAPSHOTS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .rev()
        .find(|(k, _)| k == id)
        .map(|(_, s)| s.clone())
        .ok_or_else(|| issue(IssueState::Stale, "review-expired", "This review is no longer current. Refresh it."))
}

fn create_inner(p: &ReviewCreateParams) -> R<ReviewCreateResult> {
    let max = p.max_git_bytes.unwrap_or(MAX_GIT_BYTES);
    let cwd = Path::new(&p.checkout_path);
    let scope = &p.scope;
    if !matches!(scope, GitReviewScope::Turn { .. }) {
        let not_repository = || {
            ReviewCreateResult::Issue(issue(
                IssueState::Unavailable,
                "not-a-repository",
                "This folder isn't in a Git repository, and this chat hasn't changed files in one yet.",
            ))
        };
        let top = match git_text(cwd, &["rev-parse", "--show-toplevel"], max) {
            Ok(t) => t.trim().to_string(),
            Err(e) if e.to_lowercase().contains("not a git repository") => return Ok(not_repository()),
            Err(e) => return Err(e),
        };
        let checkout = realpath(cwd)?;
        let root = realpath(Path::new(&top))?;
        if checkout != root {
            // A folder the enclosing repository ignores has no history there.
            let rel = checkout.strip_prefix(&root).map_err(|e| e.to_string())?;
            let folder = format!(
                "{}/",
                rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
            );
            let listing = git_text(&root, &["status", "--porcelain=v1", "-z", "--ignored=matching", "--", &folder], max)?;
            let ignored = listing.split('\0').any(|e| e.starts_with("!! ") && e.ends_with('/') && folder.starts_with(&e[3..]));
            return Ok(if ignored {
                not_repository()
            } else {
                ReviewCreateResult::Issue(issue(
                    IssueState::Unavailable,
                    "nested-workspace",
                    "Git review requires the checkout root. Open the repository root to review its changes.",
                ))
            });
        }
    }
    if let Some(kind) = scope.working_kind() {
        return create_working(cwd, &p.checkout_path, kind, max);
    }
    create_comparison(cwd, &p.checkout_path, scope, max)
}

fn trace(t: &Instant, what: &str) {
    if std::env::var_os("PEGASUS_REVIEW_TRACE").is_some() {
        crate::info!("review {what}: {} ms", t.elapsed().as_millis());
    }
}

fn create_working(cwd: &Path, checkout_path: &str, kind: WorkingKind, max: u64) -> R<ReviewCreateResult> {
    let t = Instant::now();
    let deadline = Instant::now() + PREPARATION;
    let head = resolve_revision(cwd, "HEAD", "commit");
    let entries: Vec<StatusFile> = parse_status(&git_text(cwd, &["status", "--porcelain=v1", "-z", "--untracked-files=all"], max)?)?
        .into_iter()
        .filter(|e| match kind {
            WorkingKind::Staged => e.has_staged,
            WorkingKind::Unstaged => e.has_unstaged,
            WorkingKind::Uncommitted => true,
        })
        .collect();
    let included = &entries[..entries.len().min(MAX_FILES)];
    trace(&t, "status");
    // The index, HEAD tree, line counts and conversion attributes are independent: run them side by side.
    let (index_blobs, base_blobs, counts, conversion) = std::thread::scope(|s| {
        let a = s.spawn(|| list_blobs(cwd, &["ls-files", "--stage", "-z"], included.iter().map(|e| e.path.as_str()), true, max));
        let b = s.spawn(|| tree(cwd, head.as_deref(), included.iter().map(|e| e.previous_path.as_deref().unwrap_or(&e.path)), max));
        let c = s.spawn(|| working_line_counts(cwd, kind, head.as_deref(), max));
        let d = s.spawn(|| conversion_notes(cwd, included));
        (join(a), join(b), join(c), join(d))
    });
    let (index_blobs, base_blobs, counts, conversion) = (index_blobs?, base_blobs?, counts?, conversion?);
    trace(&t, "listings");

    // Working-file reads are independent too; read them in parallel, then apply the shared byte budget in order.
    let workings: Vec<Option<WorkingFile>> = if kind == WorkingKind::Staged {
        included.iter().map(|_| None).collect()
    } else {
        read_all_working(cwd, included, deadline)?
    };

    trace(&t, "working files");
    let scope_kind = ScopeKind::Working(kind);
    let mut files = Vec::with_capacity(included.len());
    for (entry, working) in included.iter().zip(workings) {
        let source = FileSource {
            base: base_blobs.get(entry.previous_path.as_deref().unwrap_or(&entry.path)).and_then(|v| v.first().cloned()),
            head: None,
            index: index_blobs.get(&entry.path).cloned().unwrap_or_default(),
            working: working.as_ref().map(WorkingFile::state),
            status_records: entry.records.clone(),
        };
        let untracked = entry.records.iter().any(|r| r.starts_with("?? "));
        let lines = if entry.conflicted {
            None
        } else if untracked && (entry.status == ReviewFileStatus::Untracked || kind == WorkingKind::Unstaged) {
            // Git diff does not list untracked files, so their added lines are counted here.
            count_text_lines(working.as_ref().and_then(|w| w.bytes.as_deref()))
        } else if untracked && kind == WorkingKind::Uncommitted {
            None
        } else {
            match counts.map.get(&entry.path) {
                Some(l) => *l,
                // Git leaves out a file whose sides match, such as cancelling staged edits.
                None if counts.truncated => None,
                None => Some(ReviewLineCounts { added: 0, removed: 0 }),
            }
        };
        files.push(GitReviewFile {
            id: digest(entry.path.as_bytes()),
            path: entry.path.clone(),
            previous_path: entry.previous_path.clone(),
            status: scoped_status(entry, kind),
            has_staged_changes: entry.has_staged,
            has_unstaged_changes: entry.has_unstaged,
            conflicted: entry.conflicted,
            lines,
            fingerprint: fingerprint(&source, kind == WorkingKind::Staged),
            content_fingerprint: content_fingerprint(&source, &scope_kind),
            source,
        });
    }
    trace(&t, "fingerprints");
    // Each file is revalidated against its fingerprint before it is read, reviewed or staged.
    if head != resolve_revision(cwd, "HEAD", "commit") {
        return Ok(ReviewCreateResult::Issue(issue(
            IssueState::Stale,
            "checkout-changed",
            "The checkout changed while the review was being created. Refresh it.",
        )));
    }
    let mut notes: Vec<String> = files.iter().filter_map(|f| f.source.working.as_ref().and_then(|w| w.note.clone())).collect();
    notes.extend(conversion);
    if entries.len() > MAX_FILES {
        notes.push(format!("Only the first {MAX_FILES} changed files are included."));
    }
    trace(&t, "attributes");
    Ok(ReviewCreateResult::Available(GitReviewSnapshot {
        state: AvailableState::Available,
        id: String::new(),
        checkout_path: checkout_path.to_string(),
        scope: match kind {
            WorkingKind::Uncommitted => ReviewScope::Uncommitted,
            WorkingKind::Staged => ReviewScope::Staged,
            WorkingKind::Unstaged => ReviewScope::Unstaged,
        },
        base_label: working_base_label(kind, head.is_some()),
        head_oid: head.clone(),
        base_oid: head,
        coverage: if notes.is_empty() { ReviewCoverage::complete() } else { ReviewCoverage::partial(notes) },
        files,
        branch_name: None,
        base_options: None,
    }))
}

/// Patch generation compares raw bytes without clean/textconv conversion; say so when the files use one.
fn conversion_notes(cwd: &Path, included: &[StatusFile]) -> R<Vec<String>> {
    if included.is_empty() {
        return Ok(vec![]);
    }
    let mut paths: Vec<&str> = included.iter().take(100).map(|e| e.path.as_str()).collect();
    while paths.join("\0").encode_utf16().count() > 32_000 {
        paths.pop();
    }
    let mut args = vec!["check-attr", "-z", "filter", "working-tree-encoding", "eol", "--"];
    args.extend(paths.iter().copied());
    let attributes = git_text(cwd, &args, MAX_GIT_BYTES)?;
    let transformed = attributes.split('\0').enumerate().any(|(i, v)| i % 3 == 2 && v != "unspecified" && v != "unset");
    let autocrlf = git_text(cwd, &["config", "--get", "core.autocrlf"], MAX_GIT_BYTES).unwrap_or_default();
    let autocrlf = autocrlf.trim();
    let mut notes = vec![];
    if transformed || autocrlf == "true" || autocrlf == "input" {
        notes.push("Patches compare raw working bytes with Git blobs; configured filters and line-ending conversions are not applied.".into());
    }
    if included.len() > paths.len() {
        notes.push(format!(
            "Attribute-conversion coverage was checked for the first {} changed files only; patches use raw bytes.",
            paths.len()
        ));
    }
    Ok(notes)
}

fn join<T>(h: std::thread::ScopedJoinHandle<'_, R<T>>) -> R<T> {
    h.join().unwrap_or_else(|_| Err("review worker panicked".into()))
}

/// Reads working files on a few threads. The byte budget and deadline apply in listing order, as
/// in the sequential version: a file is read in full only while budget and time remain.
fn read_all_working(cwd: &Path, included: &[StatusFile], deadline: Instant) -> R<Vec<Option<WorkingFile>>> {
    // First pass: sizes, to hand out the byte budget deterministically before reading.
    let mut remaining = MAX_PREPARATION_BYTES;
    let mut limits = Vec::with_capacity(included.len());
    for e in included {
        let limit = if Instant::now() < deadline { remaining.min(MAX_CONTENT_BYTES) } else { 0 };
        limits.push(limit);
        let size = safe_path(cwd, &e.path)
            .ok()
            .and_then(|p| std::fs::symlink_metadata(p).ok())
            .filter(|m| m.is_file())
            .map_or(0, |m| m.len());
        if size <= limit {
            remaining = remaining.saturating_sub(size);
        }
    }
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let chunk = included.len().div_ceil(workers).max(1);
    let results: Vec<R<Vec<WorkingFile>>> = std::thread::scope(|s| {
        let handles: Vec<_> = included
            .chunks(chunk)
            .zip(limits.chunks(chunk))
            .map(|(entries, limits)| {
                s.spawn(move || entries.iter().zip(limits).map(|(e, &l)| read_working_file(cwd, &e.path, l)).collect::<R<Vec<_>>>())
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("review worker panicked".into()))).collect()
    });
    let mut out = Vec::with_capacity(included.len());
    for r in results {
        out.extend(r?.into_iter().map(Some));
    }
    Ok(out)
}

fn create_comparison(cwd: &Path, checkout_path: &str, scope: &GitReviewScope, max: u64) -> R<ReviewCreateResult> {
    let unavailable = |code: &str, msg: &str| Ok(ReviewCreateResult::Issue(issue(IssueState::Unavailable, code, msg)));
    let (head_rev, kind) = match scope {
        GitReviewScope::Turn { after_tree_oid, .. } => (after_tree_oid.as_str(), "tree"),
        _ => ("HEAD", "commit"),
    };
    let Some(head) = resolve_revision(cwd, head_rev, kind) else {
        return unavailable("missing-head", "This comparison has no available head revision.");
    };
    let base_ref = match scope {
        GitReviewScope::Turn { before_tree_oid, .. } => Some(before_tree_oid.clone()),
        GitReviewScope::Branch { base_ref } => match base_ref {
            Some(r) => Some(r.clone()),
            None => default_base(cwd)?,
        },
        _ => None,
    };
    let Some(base_ref) = base_ref else {
        return unavailable(
            "missing-base",
            "This branch has no upstream and the repository has no main branch to compare against, so there is nothing to show yet.",
        );
    };
    let Some(mut base) = resolve_revision(cwd, &base_ref, kind) else {
        return unavailable("missing-base", "The selected base reference is unavailable.");
    };
    if matches!(scope, GitReviewScope::Branch { .. }) {
        base = git_text(cwd, &["merge-base", &base, &head], max).unwrap_or_default().trim().to_string();
        if base.is_empty() {
            return unavailable("unrelated-base", "The selected base and HEAD have no common ancestor.");
        }
    }
    let names = git_text(
        cwd,
        &["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames", &base, &head, "--"],
        max,
    )?;
    struct Change {
        code: String,
        first: String,
        path: String,
        renamed: bool,
    }
    let parts: Vec<&str> = names.split('\0').collect();
    let mut changes = vec![];
    let mut i = 0;
    while i < parts.len() {
        let code = parts[i];
        i += 1;
        if code.is_empty() {
            continue;
        }
        let first = parts.get(i).copied().unwrap_or("");
        i += 1;
        let renamed = code.starts_with('R') || code.starts_with('C');
        let path = if renamed {
            let p = parts.get(i).copied().unwrap_or("");
            i += 1;
            p
        } else {
            first
        };
        if path.is_empty() || first.is_empty() {
            return Err("Invalid Git comparison listing.".into());
        }
        changes.push(Change { code: code.into(), first: first.into(), path: path.into(), renamed });
    }
    let included = &changes[..changes.len().min(MAX_FILES)];
    let (base_blobs, head_blobs, counts) = std::thread::scope(|s| {
        let a = s.spawn(|| tree(cwd, Some(&base), included.iter().map(|c| c.first.as_str()), max));
        let b = s.spawn(|| tree(cwd, Some(&head), included.iter().map(|c| c.path.as_str()), max));
        let c = s.spawn(|| numstat(cwd, &[&base, &head], max));
        (join(a), join(b), join(c))
    });
    let (base_blobs, head_blobs) = (base_blobs?, head_blobs?);
    let counts: HashMap<String, Option<ReviewLineCounts>> = counts?.into_iter().map(|f| (f.path, f.lines)).collect();
    let mut files = vec![];
    for c in included {
        let status = match c.code.as_bytes()[0] {
            b'A' => ReviewFileStatus::Added,
            b'D' => ReviewFileStatus::Deleted,
            b'R' => ReviewFileStatus::Renamed,
            b'C' => ReviewFileStatus::Copied,
            b'T' => ReviewFileStatus::Typechanged,
            _ => ReviewFileStatus::Modified,
        };
        let source = FileSource {
            base: base_blobs.get(&c.first).and_then(|v| v.first().cloned()),
            head: head_blobs.get(&c.path).and_then(|v| v.first().cloned()),
            index: vec![],
            working: None,
            status_records: vec![],
        };
        files.push(GitReviewFile {
            id: digest(c.path.as_bytes()),
            path: c.path.clone(),
            previous_path: if c.renamed { Some(c.first.clone()) } else { None },
            status,
            has_staged_changes: false,
            has_unstaged_changes: false,
            conflicted: false,
            lines: counts.get(&c.path).copied().flatten(),
            fingerprint: fingerprint(&source, false),
            content_fingerprint: content_fingerprint(&source, &ScopeKind::Other),
            source,
        });
    }
    let turn_coverage = match scope {
        GitReviewScope::Turn { coverage: Some(c), .. } => c.clone(),
        _ => ReviewCoverage::complete(),
    };
    let cap = if changes.len() > MAX_FILES {
        ReviewCoverage::partial([format!("Only the first {MAX_FILES} changed files are included.")])
    } else {
        ReviewCoverage::complete()
    };
    let is_turn = matches!(scope, GitReviewScope::Turn { .. });
    let (branch_name, base_options) = if let GitReviewScope::Branch { .. } = scope {
        let name = git_text(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], MAX_GIT_BYTES)
            .unwrap_or_default()
            .trim()
            .to_string();
        let options = list_base_options(cwd, &name, &base_ref);
        (if name.is_empty() { None } else { Some(name) }, Some(options))
    } else {
        (None, None)
    };
    Ok(ReviewCreateResult::Available(GitReviewSnapshot {
        state: AvailableState::Available,
        id: String::new(),
        checkout_path: checkout_path.to_string(),
        scope: match scope {
            GitReviewScope::Turn { checkpoint_id, .. } => ReviewScope::Turn { checkpoint_id: Some(checkpoint_id.clone()) },
            _ => ReviewScope::Branch { base_ref: Some(base_ref.clone()) },
        },
        base_label: if is_turn { "Captured turn".into() } else { short_ref_name(&base_ref) },
        head_oid: Some(head),
        base_oid: Some(base),
        coverage: ReviewCoverage::combine(&[turn_coverage, cap]),
        files,
        branch_name,
        base_options,
    }))
}

pub fn tree_changes(p: TreeChangesParams) -> R<TreeChanges> {
    let files = numstat(Path::new(&p.repository_path), &[&p.before_tree_oid, &p.after_tree_oid], MAX_GIT_BYTES)?;
    Ok(TreeChanges { files })
}

// ---------- freshness, read, stage ----------

pub fn check_current(snapshot: &GitReviewSnapshot, file_id: &str) -> Option<ReviewIssue> {
    let Some(file) = snapshot.files.iter().find(|f| f.id == file_id) else {
        return Some(issue(IssueState::Unavailable, "missing-file", "This file does not belong to the review."));
    };
    let kind = snapshot.scope.working_kind()?;
    let staged = kind == WorkingKind::Staged;
    let cwd = Path::new(&snapshot.checkout_path);
    let run = || -> R<Option<ReviewIssue>> {
        // Path-limited status only pairs a rename when both sides are in the pathspec.
        let mut own = vec![file.path.as_str()];
        if let Some(p) = &file.previous_path {
            own.push(p);
        }
        let partners: Vec<&str> = snapshot
            .files
            .iter()
            .filter(|f| f.previous_path.as_deref().is_some_and(|p| own.contains(&p)))
            .map(|f| f.path.as_str())
            .collect();
        let mut seen = HashSet::new();
        let paths: Vec<&str> = own.iter().copied().chain(partners).filter(|p| seen.insert(*p)).collect();
        let head = resolve_revision(cwd, "HEAD", "commit");
        if head != snapshot.head_oid {
            return Ok(Some(issue(IssueState::Stale, "head-changed", "HEAD changed. Refresh the review.")));
        }
        let mut args = vec!["ls-files", "--stage", "-z", "--"];
        args.extend(paths.iter().copied());
        let index = parse_blobs(&git_text(cwd, &args, MAX_GIT_BYTES)?, true)?;
        let mut source = file.source.clone();
        source.index = index.get(&file.path).cloned().unwrap_or_default();
        if !staged {
            let mut args = vec!["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"];
            args.extend(paths.iter().copied());
            source.status_records = parse_status(&git_text(cwd, &args, MAX_GIT_BYTES)?)?
                .into_iter()
                .find(|e| e.path == file.path)
                .map(|e| e.records)
                .unwrap_or_default();
            let limit = if file.source.working.as_ref().is_some_and(|w| w.note.is_some()) { 0 } else { MAX_CONTENT_BYTES };
            source.working = Some(read_working_file(cwd, &file.path, limit)?.state());
        }
        Ok(if fingerprint(&source, staged) == file.fingerprint {
            None
        } else {
            Some(issue(IssueState::Stale, "file-changed", "The file or index changed. Refresh the review before continuing."))
        })
    };
    run().unwrap_or_else(|e| Some(issue(IssueState::Unavailable, "freshness-unavailable", e)))
}

fn read_blob(cwd: &Path, r: Option<&BlobRef>) -> R<WorkingFile> {
    let Some(r) = r else { return Ok(WorkingFile::missing()) };
    if r.mode == "160000" {
        return Ok(WorkingFile {
            mode: r.mode.clone(),
            digest: r.oid.clone(),
            bytes: None,
            note: Some(format!("Submodule revision {}; nested content is not included.", r.oid)),
        });
    }
    let size: u64 = git_text(cwd, &["cat-file", "-s", &r.oid], MAX_GIT_BYTES)?.trim().parse().map_err(|_| "Git blob size is unreadable.")?;
    if size > MAX_CONTENT_BYTES {
        return Ok(WorkingFile {
            mode: r.mode.clone(),
            digest: r.oid.clone(),
            bytes: None,
            note: Some("File exceeds the 8 MiB review content limit.".into()),
        });
    }
    let out = git(cwd, &["cat-file", "blob", &r.oid], MAX_CONTENT_BYTES)?;
    if out.code != 0 || out.truncated {
        return Err("Git blob is unavailable.".into());
    }
    Ok(WorkingFile { mode: r.mode.clone(), digest: r.oid.clone(), bytes: Some(out.stdout), note: None })
}

struct ScratchDir(PathBuf);
impl Drop for ScratchDir {
    fn drop(&mut self) {
        // Windows can hold a just-closed file briefly; retry like Node's rm maxRetries.
        for attempt in 0..6 {
            if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100 * (attempt + 1)));
        }
        crate::warn!("review scratch {} could not be removed", self.0.display());
    }
}

fn scratch_dir() -> R<ScratchDir> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let dir = std::env::temp_dir().join(format!("pi-gui-review-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    Ok(ScratchDir(dir))
}

fn read_patch(path: &str, before_path: &str, before: &WorkingFile, after: &WorkingFile) -> R<(String, ReviewCoverage)> {
    if before.note.is_some() || after.note.is_some() {
        return Ok((String::new(), ReviewCoverage::partial(before.note.iter().chain(after.note.iter()).cloned())));
    }
    if before.mode == "missing" && after.mode == "missing" {
        return Ok((String::new(), ReviewCoverage::complete()));
    }
    let scratch = scratch_dir()?;
    let materialize = |side: &str, name: &str, f: &WorkingFile| -> R<String> {
        if f.mode == "missing" {
            return Ok("/dev/null".into());
        }
        let relative = format!("{side}/{name}");
        let target = safe_path(&scratch.0, &relative)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let bytes = f.bytes.as_deref().unwrap_or_default();
        if f.mode == "120000" {
            let link = String::from_utf8_lossy(bytes).into_owned();
            #[cfg(unix)]
            std::os::unix::fs::symlink(&link, &target).map_err(|e| e.to_string())?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_file(&link, &target).map_err(|e| e.to_string())?;
        } else {
            std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let m = if f.mode == "100755" { 0o755 } else { 0o644 };
                std::fs::set_permissions(&target, std::fs::Permissions::from_mode(m)).map_err(|e| e.to_string())?;
            }
        }
        Ok(relative)
    };
    let left = materialize("a", before_path, before)?;
    let right = materialize("b", path, after)?;
    let out = git(
        &scratch.0,
        &["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-prefix", "--", &left, &right],
        MAX_PATCH_BYTES,
    )?;
    let patch = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut notes = vec![];
    if out.truncated {
        notes.push("Patch is truncated at the 1 MiB review limit.".to_string());
    }
    let has_nul = |f: &WorkingFile| f.bytes.as_deref().is_some_and(|b| b[..b.len().min(8000)].contains(&0));
    if patch.contains("Binary files ") || has_nul(before) || has_nul(after) {
        notes.push("Binary file contents are not rendered; the patch reports whether they differ.".into());
    }
    Ok((patch, if notes.is_empty() { ReviewCoverage::complete() } else { ReviewCoverage::partial(notes) }))
}

pub fn read_file(snapshot: &GitReviewSnapshot, file_id: &str) -> ReviewReadResult {
    let Some(file) = snapshot.files.iter().find(|f| f.id == file_id) else {
        return ReviewReadResult::Issue(issue(IssueState::Unavailable, "missing-file", "This file does not belong to the review."));
    };
    if let Some(stale) = check_current(snapshot, file_id) {
        return ReviewReadResult::Issue(stale);
    }
    let cwd = Path::new(&snapshot.checkout_path);
    let run = || -> R<ReviewReadResult> {
        let working_kind = snapshot.scope.working_kind();
        let read_index = || read_blob(cwd, file.source.index.iter().find(|b| b.stage == Some(0)));
        let read_working = || -> R<WorkingFile> {
            match &file.source.working {
                Some(w) if w.note.is_some() => {
                    Ok(WorkingFile { mode: w.mode.clone(), digest: w.digest.clone(), bytes: None, note: w.note.clone() })
                }
                _ => read_working_file(cwd, &file.path, MAX_CONTENT_BYTES),
            }
        };
        // A conflict has no single index side: Uncommitted and Unstaged show HEAD → working tree.
        let side = if file.conflicted && working_kind.is_some() { Some(WorkingKind::Uncommitted) } else { working_kind };
        let conflicted_staged = file.conflicted && working_kind == Some(WorkingKind::Staged);
        let before_path = if side == Some(WorkingKind::Unstaged) { file.path.as_str() } else { file.previous_path.as_deref().unwrap_or(&file.path) };
        let (patch, coverage) = if conflicted_staged {
            (String::new(), ReviewCoverage::complete())
        } else {
            let before = if side == Some(WorkingKind::Unstaged) { read_index()? } else { read_blob(cwd, file.source.base.as_ref())? };
            let after = match side {
                Some(WorkingKind::Staged) => read_index()?,
                Some(_) => read_working()?,
                None => read_blob(cwd, file.source.head.as_ref())?,
            };
            read_patch(&file.path, before_path, &before, &after)?
        };
        let summary = if file.conflicted {
            let stages: Vec<String> = file
                .source
                .index
                .iter()
                .map(|b| format!("{} {}", match b.stage { Some(1) => "base", Some(2) => "ours", _ => "theirs" }, b.oid))
                .collect();
            Some(format!("Unmerged index stages: {}. Resolve the conflict before staging through review.", stages.join("; ")))
        } else if working_kind == Some(WorkingKind::Uncommitted) && patch.is_empty() && file.has_staged_changes && file.has_unstaged_changes {
            Some("The combined contents match HEAD; staged and unstaged changes cancel each other. Choose Staged or Unstaged to see each part.".into())
        } else {
            None
        };
        if let Some(current) = check_current(snapshot, file_id) {
            return Ok(ReviewReadResult::Issue(current));
        }
        let conflict_cov = if file.conflicted {
            ReviewCoverage::partial(["Unmerged index stages are summarized; no staged or unstaged patch is claimed.".to_string()])
        } else {
            ReviewCoverage::complete()
        };
        Ok(ReviewReadResult::Available(GitReviewFileContent {
            state: AvailableState::Available,
            patch,
            coverage: ReviewCoverage::combine(&[coverage, conflict_cov]),
            summary,
        }))
    };
    run().unwrap_or_else(|e| ReviewReadResult::Issue(issue(IssueState::Failed, "file-review-failed", e)))
}

pub fn stage(snapshot: &GitReviewSnapshot, file_id: &str, action: StageAction) -> ReviewStageResult {
    let fail = |state, code: &str, msg: &str| ReviewStageResult::Issue(issue(state, code, msg));
    let Some(kind) = snapshot.scope.working_kind() else {
        return fail(IssueState::Unavailable, "immutable-comparison", "Only Uncommitted, Staged and Unstaged review can change the index.");
    };
    // Staged and Unstaged only move the side they show.
    let allowed = match kind {
        WorkingKind::Uncommitted => true,
        WorkingKind::Staged => action == StageAction::Unstage,
        WorkingKind::Unstaged => action == StageAction::Stage,
    };
    if !allowed {
        return fail(
            IssueState::Unavailable,
            "unseen-stage-change",
            if action == StageAction::Stage {
                "Staged review cannot stage working-tree edits it does not show."
            } else {
                "Unstaged review cannot unstage index changes it does not show."
            },
        );
    }
    let Some(file) = snapshot.files.iter().find(|f| f.id == file_id) else {
        return fail(IssueState::Unavailable, "missing-file", "This file does not belong to the review.");
    };
    if file.conflicted || file.source.working.as_ref().is_some_and(|w| w.note.is_some()) {
        return fail(
            IssueState::Unavailable,
            "unsupported-staging",
            "Resolve this file's conflict or incomplete coverage before staging it through review.",
        );
    }
    if let Some(stale) = check_current(snapshot, file_id) {
        return ReviewStageResult::Issue(stale);
    }
    // A staged rename already removed its previous path, so `git add` names only the current path;
    // unstaging restores both halves of the pair.
    let mut paths = vec![file.path.as_str()];
    if let Some(p) = file.previous_path.as_deref().filter(|p| *p != file.path) {
        paths.push(p);
    }
    let cwd = Path::new(&snapshot.checkout_path);
    let args: Vec<&str> = match (action, &snapshot.head_oid) {
        (StageAction::Stage, _) => vec!["add", "--", &file.path],
        (StageAction::Unstage, Some(head)) => [vec!["reset", "--quiet", head.as_str(), "--"], paths].concat(),
        (StageAction::Unstage, None) => [vec!["rm", "--cached", "--ignore-unmatch", "--force", "--"], paths].concat(),
    };
    match git_text(cwd, &args, MAX_GIT_BYTES) {
        Ok(_) => ReviewStageResult::Applied(StageApplied { state: AppliedState::Applied }),
        Err(e) => ReviewStageResult::Issue(issue(IssueState::Failed, "stage-failed", e)),
    }
}
