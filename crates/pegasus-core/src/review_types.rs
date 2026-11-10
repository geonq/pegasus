//! Git review types shared by the host and its TypeScript clients. They mirror
//! apps/desktop/contracts/review.ts (ReviewScope, ReviewIssue, ReviewCoverage, ReviewFileEntry) so the
//! generated TS is structurally the same as what the renderer already consumes.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CoverageState {
    Complete,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReviewCoverage {
    pub state: CoverageState,
    pub notes: Vec<String>,
}

impl ReviewCoverage {
    pub fn complete() -> Self {
        ReviewCoverage { state: CoverageState::Complete, notes: vec![] }
    }
    /// Partial with de-duplicated notes, first occurrence order (like `[...new Set(notes)]`).
    pub fn partial<I: IntoIterator<Item = String>>(notes: I) -> Self {
        let mut out: Vec<String> = Vec::new();
        for n in notes {
            if !out.contains(&n) {
                out.push(n);
            }
        }
        ReviewCoverage { state: CoverageState::Partial, notes: out }
    }
    pub fn combine(all: &[ReviewCoverage]) -> Self {
        if all.iter().any(|c| c.state == CoverageState::Partial) {
            Self::partial(all.iter().flat_map(|c| c.notes.iter().cloned()))
        } else {
            Self::complete()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IssueState {
    Stale,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReviewIssue {
    pub state: IssueState,
    pub code: String,
    pub message: String,
}

impl ReviewIssue {
    pub fn new(state: IssueState, code: &str, message: impl Into<String>) -> Self {
        ReviewIssue { state, code: code.into(), message: message.into() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFileStatus {
    Added,
    Copied,
    Deleted,
    Modified,
    Renamed,
    Untracked,
    Conflicted,
    Typechanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReviewLineCounts {
    pub added: u64,
    pub removed: u64,
}

/// The scope a snapshot reports back (contracts ReviewScope).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReviewScope {
    Uncommitted,
    Staged,
    Unstaged,
    Branch {
        #[serde(rename = "baseRef", skip_serializing_if = "Option::is_none", default)]
        #[ts(optional)]
        base_ref: Option<String>,
    },
    Turn {
        #[serde(rename = "checkpointId", skip_serializing_if = "Option::is_none", default)]
        #[ts(optional)]
        checkpoint_id: Option<String>,
    },
}

/// What a review is created from: a contracts scope, or a captured turn with its two trees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitReviewScope {
    Uncommitted,
    Staged,
    Unstaged,
    Branch {
        #[serde(rename = "baseRef", skip_serializing_if = "Option::is_none", default)]
        #[ts(optional)]
        base_ref: Option<String>,
    },
    Turn {
        #[serde(rename = "checkpointId")]
        checkpoint_id: String,
        #[serde(rename = "beforeTreeOid")]
        before_tree_oid: String,
        #[serde(rename = "afterTreeOid")]
        after_tree_oid: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        #[ts(optional)]
        coverage: Option<ReviewCoverage>,
    },
}

impl GitReviewScope {
    pub fn working_kind(&self) -> Option<WorkingKind> {
        match self {
            GitReviewScope::Uncommitted => Some(WorkingKind::Uncommitted),
            GitReviewScope::Staged => Some(WorkingKind::Staged),
            GitReviewScope::Unstaged => Some(WorkingKind::Unstaged),
            _ => None,
        }
    }
}

impl ReviewScope {
    pub fn working_kind(&self) -> Option<WorkingKind> {
        match self {
            ReviewScope::Uncommitted => Some(WorkingKind::Uncommitted),
            ReviewScope::Staged => Some(WorkingKind::Staged),
            ReviewScope::Unstaged => Some(WorkingKind::Unstaged),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkingKind {
    Uncommitted,
    Staged,
    Unstaged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct BlobRef {
    pub mode: String,
    pub oid: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub stage: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct WorkingState {
    pub mode: String,
    pub digest: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub note: Option<String>,
}

/// Everything a file comparison read. Field order matters: fingerprints hash its JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileSource {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub base: Option<BlobRef>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub head: Option<BlobRef>,
    pub index: Vec<BlobRef>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub working: Option<WorkingState>,
    pub status_records: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewFile {
    pub id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub previous_path: Option<String>,
    pub status: ReviewFileStatus,
    pub has_staged_changes: bool,
    pub has_unstaged_changes: bool,
    pub conflicted: bool,
    pub lines: Option<ReviewLineCounts>,
    /// Everything the comparison read, including the index; any change makes actions stale.
    pub fingerprint: String,
    /// The reviewed content only. Staging moves it into the index without changing it.
    pub content_fingerprint: String,
    pub source: FileSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ReviewBaseOption {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AvailableState {
    Available,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewSnapshot {
    pub state: AvailableState,
    /// Handle for file reads, checks and staging; the host keeps recent snapshots by this id.
    #[serde(default)]
    pub id: String,
    pub checkout_path: String,
    pub scope: ReviewScope,
    pub base_label: String,
    pub head_oid: Option<String>,
    pub base_oid: Option<String>,
    pub coverage: ReviewCoverage,
    pub files: Vec<GitReviewFile>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub branch_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub base_options: Option<Vec<ReviewBaseOption>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum ReviewCreateResult {
    Available(GitReviewSnapshot),
    Issue(ReviewIssue),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct GitReviewFileContent {
    pub state: AvailableState,
    pub patch: String,
    pub coverage: ReviewCoverage,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum ReviewReadResult {
    Available(GitReviewFileContent),
    Issue(ReviewIssue),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AppliedState {
    Applied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct StageApplied {
    pub state: AppliedState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum ReviewStageResult {
    Applied(StageApplied),
    Issue(ReviewIssue),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangedFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub previous_path: Option<String>,
    pub lines: Option<ReviewLineCounts>,
}

// ---- method params ----

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewCreateParams {
    pub checkout_path: String,
    pub scope: GitReviewScope,
    /// Output cap for one Git listing; larger output makes the review unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_git_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFileParams {
    pub snapshot_id: String,
    pub file_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum StageAction {
    Stage,
    Unstage,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewStageParams {
    pub snapshot_id: String,
    pub file_id: String,
    pub action: StageAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeChangesParams {
    pub repository_path: String,
    pub before_tree_oid: String,
    pub after_tree_oid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TreeChanges {
    pub files: Vec<TurnChangedFile>,
}

/// `checkFileCurrent` answers null when the file is current.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ReviewCheckResult {
    pub issue: Option<ReviewIssue>,
}
