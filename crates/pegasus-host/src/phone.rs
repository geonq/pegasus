//! Phone-sized views of what the desktop already sends (contract: remote-phone.md). Pure functions over
//! the provider's JSON, so the phone downloads a summary, a page or parsed hunks instead of the whole
//! state, transcript or patch, and does not filter or parse them in JS.
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const PREVIEW_CHARS: usize = 160;
pub const DEFAULT_PAGE: usize = 50;
pub const MAX_PAGE: usize = 200;
/// A page stops growing past this many JSON bytes (it always holds at least one entry).
pub const PAGE_BUDGET_BYTES: usize = 512 * 1024;
/// Tool and activity `detail` (command output) beyond this is cut; message text never is.
pub const DETAIL_CHARS: usize = 8 * 1024;
pub const DEFAULT_DIFF_BYTES: usize = 256 * 1024;
pub const MIN_DIFF_BYTES: usize = 4 * 1024;
pub const MAX_DIFF_BYTES: usize = 1024 * 1024;
const MAX_DIFF_LINE_CHARS: usize = 4000;
/// Rough JSON size of a file or hunk object without its lines, counted against the cap.
const DIFF_OBJECT_BYTES: usize = 120;

fn text<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k)?.as_str()
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Cut to `max` chars on a char boundary; true when something was cut.
fn clip(s: &str, max: usize) -> (&str, bool) {
    match s.char_indices().nth(max) {
        Some((i, _)) => (&s[..i], true),
        None => (s, false),
    }
}

fn key(ws: &str, id: &str) -> String {
    format!("{ws}:{id}")
}

/// The chat list the phone shows, computed like apps/mobile/src/api/chats.ts (rowsOf/buildHome):
/// unarchived chats, newest activity first, with needs-you/unread already decided.
pub fn chat_list(state: &Value) -> Value {
    let workspaces = arr(state, "workspaces");
    let ids: HashSet<&str> = workspaces.iter().filter_map(|w| text(w, "id")).collect();
    let project_of = |w: &Value| -> String {
        let id = text(w, "id").unwrap_or("");
        match (text(w, "kind"), text(w, "rootWorkspaceId")) {
            (Some("worktree"), Some(root)) if ids.contains(root) => root.to_string(),
            _ => id.to_string(),
        }
    };
    let order: Vec<&str> = arr(state, "workspaceOrder").iter().filter_map(Value::as_str).collect();
    // Same rank as projectsOf: unknown ids rank -1, so they come first, then by position.
    let rank = |id: &str| order.iter().position(|o| *o == id).map_or(-1, |i| i as i64);
    let mut projects: Vec<(usize, &Value)> = workspaces
        .iter()
        .enumerate()
        .filter(|(_, w)| text(w, "kind") != Some("worktree") || !text(w, "rootWorkspaceId").is_some_and(|r| ids.contains(r)))
        .collect();
    projects.sort_by_key(|(i, w)| (rank(text(w, "id").unwrap_or("")), *i));
    let projects: Vec<Value> = projects
        .into_iter()
        .map(|(_, w)| json!({ "id": text(w, "id").unwrap_or(""), "name": text(w, "name").unwrap_or("") }))
        .collect();

    let listed: HashSet<String> = workspaces
        .iter()
        .flat_map(|w| arr(w, "sessions").iter().map(move |s| key(text(w, "id").unwrap_or(""), text(s, "id").unwrap_or(""))))
        .collect();
    let mut child_keys = HashSet::new();
    let mut child_counts: HashMap<String, u64> = HashMap::new();
    for c in arr(state, "orchestrationChildren") {
        let ck = key(text(c, "childWorkspaceId").unwrap_or(""), text(c, "childSessionId").unwrap_or(""));
        let pk = key(text(c, "parentWorkspaceId").unwrap_or(""), text(c, "parentSessionId").unwrap_or(""));
        if ck == pk || !listed.contains(&ck) || !listed.contains(&pk) {
            continue;
        }
        child_keys.insert(ck);
        *child_counts.entry(pk).or_default() += 1;
    }
    let ext = state.get("sessionExtensionUiBySession");

    let mut chats: Vec<(String, String, Value)> = vec![];
    for w in workspaces {
        let ws = text(w, "id").unwrap_or("");
        let project = project_of(w);
        for s in arr(w, "sessions") {
            if s.get("archivedAt").is_some_and(|a| !a.is_null()) {
                continue;
            }
            let id = text(s, "id").unwrap_or("");
            let k = key(ws, id);
            let waiting = ext.and_then(|e| e.get(&k)).map_or(0, |u| arr(u, "pendingDialogs").len());
            let status = text(s, "status").unwrap_or("idle");
            let unseen = s.get("hasUnseenUpdate").and_then(Value::as_bool).unwrap_or(false);
            let needs_you = waiting > 0 || (status == "failed" && unseen);
            let section = if needs_you { "needs-you" } else if status == "running" { "working" } else { "recent" };
            let child = child_keys.contains(&k);
            // A settled child is listed under its parent (only counted), as on the desktop.
            if child && section == "recent" {
                continue;
            }
            let title = text(s, "title").unwrap_or("");
            let last = text(s, "lastInteractedAt").or_else(|| text(s, "updatedAt")).unwrap_or("");
            let (preview, _) = clip(text(s, "preview").unwrap_or(""), PREVIEW_CHARS);
            let mut row = Map::new();
            row.insert("workspaceId".into(), ws.into());
            row.insert("id".into(), id.into());
            row.insert("title".into(), title.into());
            row.insert("projectId".into(), project.as_str().into());
            row.insert("status".into(), status.into());
            row.insert("section".into(), section.into());
            row.insert("needsYou".into(), needs_you.into());
            row.insert("unread".into(), (section == "recent" && unseen).into());
            row.insert("lastActivity".into(), last.into());
            row.insert("preview".into(), preview.into());
            if waiting > 0 {
                row.insert("waiting".into(), waiting.into());
            }
            if let Some(n) = child_counts.get(&k) {
                row.insert("childCount".into(), (*n).into());
            }
            if child {
                row.insert("child".into(), true.into());
            }
            for opt in ["pinnedAt", "runningSince", "currentStep"] {
                if let Some(v) = text(s, opt) {
                    row.insert(opt.into(), v.into());
                }
            }
            chats.push((last.to_string(), title.to_string(), Value::Object(row)));
        }
    }
    chats.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let chats: Vec<Value> = chats.into_iter().map(|(_, _, v)| v).collect();
    let pinned = state.get("pinnedSessionOrder").cloned().unwrap_or_else(|| json!([]));
    let body = json!({ "projects": projects, "chats": chats, "pinnedSessionOrder": pinned });
    let etag = crate::review::digest(&serde_json::to_vec(&body).unwrap_or_default())[..16].to_string();
    let mut out = body;
    out["etag"] = etag.into();
    out["revision"] = state.get("revision").cloned().unwrap_or(Value::Null);
    out
}

/// Why a transcript page could not be built.
#[derive(Debug, PartialEq)]
pub enum PageError {
    /// The PC's selected transcript is another chat (or none): the phone opens it first (selectSession).
    NotSelected,
    /// `before` names no entry of this transcript (it was removed); reload the newest page.
    UnknownEntry,
}

fn compact_entry(item: &Value) -> Value {
    let mut item = item.clone();
    let kind = text(&item, "kind").unwrap_or("");
    if matches!(kind, "tool" | "activity") {
        if let Some(Value::String(d)) = item.get("detail") {
            let (cut, was) = clip(d, DETAIL_CHARS);
            if was {
                let cut = cut.to_string();
                item["detail"] = cut.into();
                item["detailTruncated"] = true.into();
            }
        }
    }
    item
}

/// Newest entries first served: the `limit` entries before `before` (or the end), oldest of them first.
pub fn transcript_page(t: &Value, workspace_id: &str, session_id: &str, limit: usize, before: Option<&str>) -> Result<Value, PageError> {
    if text(t, "workspaceId") != Some(workspace_id) || text(t, "sessionId") != Some(session_id) {
        return Err(PageError::NotSelected);
    }
    let items = arr(t, "transcript");
    let end = match before {
        None => items.len(),
        Some(id) => items.iter().position(|i| text(i, "id") == Some(id)).ok_or(PageError::UnknownEntry)?,
    };
    let limit = limit.clamp(1, MAX_PAGE);
    let mut entries = vec![];
    let mut bytes = 0;
    let mut start = end;
    while start > 0 && entries.len() < limit {
        let e = compact_entry(&items[start - 1]);
        let size = serde_json::to_vec(&e).map_or(0, |b| b.len());
        if !entries.is_empty() && bytes + size > PAGE_BUDGET_BYTES {
            break;
        }
        bytes += size;
        entries.push(e);
        start -= 1;
    }
    entries.reverse();
    Ok(json!({
        "workspaceId": workspace_id,
        "sessionId": session_id,
        "total": items.len(),
        "start": start,
        "hasMore": start > 0,
        "entries": entries,
    }))
}

fn hunk_header(line: &str) -> Option<(u64, u64, u64, u64, &str)> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, ctx) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let range = |r: &str| -> Option<(u64, u64)> {
        match r.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((r.parse().ok()?, 1)),
        }
    };
    let (os, ol) = range(old)?;
    let (ns, nl) = range(new)?;
    Some((os, ol, ns, nl, ctx.trim_start()))
}

fn diff_path(raw: &str) -> Value {
    let p = raw.split('\t').next().unwrap_or(raw).trim_end();
    if p == "/dev/null" {
        return Value::Null;
    }
    p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).unwrap_or(p).into()
}

/// A unified diff (Git's `diff --git` output or plain ---/+++) as files and hunks, cut at `max_bytes`
/// of line text. Lines keep their ' ', '+', '-' or '\' prefix.
pub fn parse_patch(patch: &str, max_bytes: usize) -> Value {
    let max_bytes = max_bytes.clamp(MIN_DIFF_BYTES, MAX_DIFF_BYTES);
    let mut files: Vec<Value> = vec![];
    let mut used = 0usize;
    let mut truncated = false;
    let mut omitted = 0u64;
    // Lines still expected in the open hunk (old, new): a body line like "--- x" stays a body line.
    let (mut old_left, mut new_left) = (0u64, 0u64);
    let new_file = |files: &mut Vec<Value>, used: &mut usize| {
        *used += DIFF_OBJECT_BYTES;
        files.push(json!({ "oldPath": null, "newPath": null, "binary": false, "hunks": [] }));
    };
    for line in patch.lines() {
        if truncated {
            // Past the cap nothing is added; only the hidden lines are counted.
            if matches!(line.as_bytes().first(), Some(b' ' | b'+' | b'-')) && !line.starts_with("--- ") && !line.starts_with("+++ ") {
                omitted += 1;
            }
            continue;
        }
        // Only ' ', '+', '-' (or an empty context line) belong to a hunk: a wrong count cannot eat a header.
        let body_line = matches!(line.as_bytes().first(), None | Some(b' ' | b'+' | b'-'));
        if (old_left > 0 || new_left > 0) && body_line {
            match line.as_bytes().first() {
                Some(b'+') => new_left = new_left.saturating_sub(1),
                Some(b'-') => old_left = old_left.saturating_sub(1),
                _ => {
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                }
            }
            let (cut, _) = clip(line, MAX_DIFF_LINE_CHARS);
            if used + cut.len() + 3 > max_bytes {
                truncated = true;
                omitted += 1;
                continue;
            }
            used += cut.len() + 3;
            if let Some(h) = files.last_mut().and_then(|f| f["hunks"].as_array_mut()).and_then(|h| h.last_mut()) {
                if let Some(lines) = h["lines"].as_array_mut() {
                    lines.push(cut.into());
                }
            }
            continue;
        }
        if line.starts_with('\\') {
            // "\ No newline at end of file" follows the hunk's last counted line.
            if let Some(lines) = files.last_mut().and_then(|f| f["hunks"].as_array_mut()).and_then(|h| h.last_mut()).and_then(|h| h["lines"].as_array_mut()) {
                if !truncated {
                    lines.push(line.into());
                }
            }
        } else if used + DIFF_OBJECT_BYTES > max_bytes {
            truncated = true;
        } else if line.starts_with("diff --git ") {
            new_file(&mut files, &mut used);
        } else if let Some(p) = line.strip_prefix("--- ") {
            // A plain diff (no git header), or a second file in one: a new file starts here.
            if files.last().is_none_or(|f| f["oldPath"] != Value::Null || !f["hunks"].as_array().is_none_or(Vec::is_empty)) {
                new_file(&mut files, &mut used);
            }
            if let Some(f) = files.last_mut() {
                f["oldPath"] = diff_path(p);
            }
        } else if let Some(p) = line.strip_prefix("+++ ") {
            if let Some(f) = files.last_mut() {
                f["newPath"] = diff_path(p);
            }
        } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
            if let Some(f) = files.last_mut() {
                f["binary"] = true.into();
            }
        } else if let Some((os, ol, ns, nl, ctx)) = hunk_header(line) {
            if files.is_empty() {
                new_file(&mut files, &mut used);
            }
            used += DIFF_OBJECT_BYTES;
            old_left = ol;
            new_left = nl;
            if let Some(h) = files.last_mut().and_then(|f| f["hunks"].as_array_mut()) {
                h.push(json!({ "oldStart": os, "oldLines": ol, "newStart": ns, "newLines": nl, "header": ctx, "lines": [] }));
            }
        }
    }
    json!({ "files": files, "truncated": truncated, "omittedLines": omitted })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, status: &str, unseen: bool, at: &str) -> Value {
        json!({"id": id, "title": format!("T {id}"), "updatedAt": at, "preview": "p".repeat(400), "status": status, "hasUnseenUpdate": unseen})
    }

    #[test]
    fn chat_list_matches_the_phone_rules_and_etag_ignores_unrelated_fields() {
        let state = json!({
            "revision": 7,
            "workspaces": [
                {"id": "w1", "name": "One", "path": "/1", "kind": "local", "sessions": [
                    session("a", "idle", true, "2026-01-03"),
                    session("b", "failed", true, "2026-01-01"),
                    session("c", "running", false, "2026-01-02"),
                    {"id": "z", "title": "gone", "updatedAt": "2026-01-09", "preview": "", "status": "idle", "hasUnseenUpdate": false, "archivedAt": "x"},
                    session("kid", "idle", false, "2026-01-05"),
                ]},
                {"id": "wt", "name": "Tree", "path": "/t", "kind": "worktree", "rootWorkspaceId": "w1", "sessions": [session("d", "idle", false, "2026-01-04")]},
            ],
            "workspaceOrder": ["w1"],
            "sessionExtensionUiBySession": {"w1:c": {"pendingDialogs": [{"kind": "confirm"}]}},
            "orchestrationChildren": [{"parentWorkspaceId": "w1", "parentSessionId": "a", "childWorkspaceId": "w1", "childSessionId": "kid"}],
            "sessionUsageBySession": {"w1:a": {"subscription": true}},
        });
        let l = chat_list(&state);
        let ids: Vec<&str> = l["chats"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["d", "a", "c", "b"], "{l}");
        let by = |id: &str| l["chats"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap().clone();
        assert_eq!(by("a")["unread"], true);
        assert_eq!(by("a")["childCount"], 1);
        assert_eq!(by("b")["needsYou"], true);
        assert_eq!(by("c")["needsYou"], true);
        assert_eq!(by("c")["waiting"], 1);
        assert_eq!(by("d")["projectId"], "w1");
        assert_eq!(by("a")["preview"].as_str().unwrap().len(), PREVIEW_CHARS);
        assert_eq!(l["projects"], json!([{"id": "w1", "name": "One"}]));
        // A revision bump or a usage change does not change the list, so the etag stays.
        let mut next = state.clone();
        next["revision"] = 8.into();
        next["sessionUsageBySession"] = json!({});
        assert_eq!(chat_list(&next)["etag"], l["etag"]);
        next["workspaces"][0]["sessions"][0]["title"] = "renamed".into();
        assert_ne!(chat_list(&next)["etag"], l["etag"]);
    }

    #[test]
    fn transcript_pages_walk_back_by_id_and_cut_tool_output() {
        let items: Vec<Value> = (0..120)
            .map(|i| if i == 119 { json!({"kind": "tool", "id": format!("e{i}"), "detail": "x".repeat(DETAIL_CHARS + 10)}) } else { json!({"kind": "message", "id": format!("e{i}"), "text": "hi"}) })
            .collect();
        let t = json!({"workspaceId": "w", "sessionId": "s", "transcript": items});
        let p = transcript_page(&t, "w", "s", 50, None).unwrap();
        assert_eq!((p["start"].as_u64(), p["hasMore"].as_bool(), p["total"].as_u64()), (Some(70), Some(true), Some(120)));
        assert_eq!(p["entries"][0]["id"], "e70");
        assert_eq!(p["entries"][49]["detailTruncated"], true);
        assert_eq!(p["entries"][49]["detail"].as_str().unwrap().len(), DETAIL_CHARS);
        let older = transcript_page(&t, "w", "s", 500, Some("e70")).unwrap();
        assert_eq!((older["start"].as_u64(), older["entries"].as_array().unwrap().len()), (Some(0), 70));
        assert_eq!(older["hasMore"], false);
        assert_eq!(transcript_page(&t, "w", "other", 50, None), Err(PageError::NotSelected));
        assert_eq!(transcript_page(&Value::Null, "w", "s", 50, None), Err(PageError::NotSelected));
        assert_eq!(transcript_page(&t, "w", "s", 50, Some("nope")), Err(PageError::UnknownEntry));
    }

    #[test]
    fn transcript_page_respects_its_byte_budget_but_returns_one_entry() {
        let big = |i: usize| json!({"kind": "message", "id": format!("e{i}"), "text": "y".repeat(PAGE_BUDGET_BYTES / 2)});
        let t = json!({"workspaceId": "w", "sessionId": "s", "transcript": [big(0), big(1), big(2)]});
        let p = transcript_page(&t, "w", "s", 50, None).unwrap();
        assert_eq!(p["entries"].as_array().unwrap().len(), 1);
        let huge = json!({"workspaceId": "w", "sessionId": "s", "transcript": [{"kind": "message", "id": "h", "text": "z".repeat(PAGE_BUDGET_BYTES * 2)}]});
        assert_eq!(transcript_page(&huge, "w", "s", 50, None).unwrap()["entries"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn parses_git_patches_into_hunks_and_caps_them() {
        let patch = "diff --git a/src/x.rs b/src/x.rs\nindex 1..2 100644\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -1,3 +1,3 @@ fn main\n a\n--- removed line that looks like a header\n+b\n c\n\\ No newline at end of file\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\ndiff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n";
        let d = parse_patch(patch, DEFAULT_DIFF_BYTES);
        let f = d["files"].as_array().unwrap();
        assert_eq!(f.len(), 3, "{d}");
        assert_eq!((f[0]["oldPath"].as_str(), f[0]["newPath"].as_str()), (Some("src/x.rs"), Some("src/x.rs")));
        assert_eq!(f[0]["hunks"][0]["header"], "fn main");
        assert_eq!(f[0]["hunks"][0]["lines"], json!([" a", "--- removed line that looks like a header", "+b", " c", "\\ No newline at end of file"]));
        assert_eq!((f[1]["oldPath"].clone(), f[1]["hunks"][0]["newStart"].as_u64(), f[1]["hunks"][0]["newLines"].as_u64()), (Value::Null, Some(1), Some(1)));
        assert_eq!(f[2]["binary"], true);
        assert_eq!(d["truncated"], false);

        let mut long = String::from("--- a/f\n+++ b/f\n@@ -1,0 +1,5000 @@\n");
        for i in 0..5000 {
            long.push_str(&format!("+line {i} {}\n", "q".repeat(20)));
        }
        let d = parse_patch(&long, MIN_DIFF_BYTES);
        let kept = d["files"][0]["hunks"][0]["lines"].as_array().unwrap().len() as u64;
        assert_eq!(d["truncated"], true);
        assert_eq!(kept + d["omittedLines"].as_u64().unwrap(), 5000);
        assert!(serde_json::to_vec(&d["files"]).unwrap().len() < MIN_DIFF_BYTES + 512, "{}", kept);
    }
}
