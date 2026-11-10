//! The one schema for everything that crosses the host boundary. TypeScript types are generated from
//! these definitions (`ts_bindings`), and `cargo test` fails when the checked-in file is stale, so the
//! Rust host and the TS clients cannot drift apart.
//!
//! Envelope (u32 big-endian length, then UTF-8 JSON):
//! request  `{"v":2,"id":N,"method":"..","params":{..}}`
//! response `{"v":2,"id":N,"result":..}` or `{"v":2,"id":N,"error":{"code":"..","message":".."}}`
//! event    `{"v":2,"event":"..","data":..}` (host -> client, no id)
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PROTOCOL: u32 = 2;
/// Largest request frame. Remote replies and published states carry up to the remote API's 24 MB
/// response cap; the pipe/socket only accepts local connections of the same user.
pub const MAX_REQUEST: usize = 32 << 20;

/// Every failure has one of these codes. Clients switch on the code, never on the message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    BadParams,
    UnknownMethod,
    UnsupportedProtocol,
    BadPath,
    OutsideRoot,
    NotASession,
    UnsupportedVersion,
    Io,
    NotFound,
    AlreadyExists,
    SpawnFailed,
    ShuttingDown,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HostError {
    pub code: ErrorCode,
    pub message: String,
}

impl HostError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        HostError { code, message: message.into() }
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloParams {
    /// Who is connecting, for the host log ("electron", "test", "ios").
    pub client: String,
    /// The app version that started this client; the host compares it with its own.
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol: u32,
    pub host_version: String,
    pub pid: u32,
    pub started_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub pid: u32,
    pub host_version: String,
    pub uptime_ms: f64,
    pub clients: u32,
    /// Work that must not be interrupted (runs, open terminals). The host refuses a soft shutdown while > 0.
    pub active_work: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownParams {
    pub reason: String,
    /// Exit even with active work (app update after the user agreed, tests).
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownResult {
    pub accepted: bool,
    pub active_work: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListParams {
    /// One session directory; omitted = every directory under the sessions root.
    #[ts(optional)]
    pub dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: String,
    pub id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub parent_session_path: Option<String>,
    pub version: u32,
    pub created_ms: Option<f64>,
    pub modified_ms: f64,
    pub message_count: u32,
    pub first_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SessionList {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextParams {
    pub path: String,
    pub pin_type: String,
}

/// pi's own session entry JSON, passed through byte for byte (pi owns that schema).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(type = "SessionEntry")]
pub struct RawEntry(pub serde_json::Value);

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionContext {
    pub total: u32,
    pub version: u32,
    pub leaf_id: Option<String>,
    pub entries: Vec<RawEntry>,
    pub pins: Vec<RawEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SliceParams {
    pub path: String,
    pub pin_type: String,
    pub start: u32,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SessionSlice {
    pub total: u32,
    pub start: u32,
    pub entries: Vec<RawEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TailParams {
    pub path: String,
    /// Byte offset from an earlier tail; omitted = start following at the current end.
    #[ts(optional)]
    pub from: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SessionTail {
    pub offset: u64,
    /// The file shrank (rewritten): reload from 0.
    pub reset: bool,
    pub lines: Vec<RawEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalSpawnParams {
    /// Client-chosen id, unique per host; reusing a live id is an error.
    pub id: String,
    pub shell: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    /// The complete environment (the host does not inherit its own).
    pub env: std::collections::BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    /// Opaque client metadata (workspace, thread scope) so a restarted client can adopt the terminal.
    pub tag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub shell: String,
    pub cwd: String,
    pub tag: String,
    pub status: TerminalStatus,
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TerminalId {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub info: TerminalInfo,
    /// Output so far (last ~1M chars), to repaint before live data resumes.
    pub replay: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TerminalWriteParams {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TerminalResizeParams {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TerminalList {
    pub terminals: Vec<TerminalInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteClientConfig {
    pub id: String,
    /// sha256 of the device's bearer token, hex; the token itself never reaches the host.
    pub token_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteServeParams {
    pub port: u16,
    pub allowed_origins: Vec<String>,
    pub clients: Vec<RemoteClientConfig>,
    /// More IPv4 addresses to listen on besides 127.0.0.1 (the PC's Tailscale address for the phone).
    #[serde(default)]
    #[ts(optional)]
    pub extra_binds: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RemoteError {
    /// HTTP status the device receives.
    pub status: u16,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteReplyParams {
    pub request_id: u64,
    pub ok: bool,
    /// Passed through as raw JSON: the host never parses or re-encodes a (possibly large) result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub value: Option<Box<serde_json::value::RawValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<RemoteError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemotePublishParams {
    pub client_id: String,
    /// A RemoteDesktopEvent (apps/desktop/electron/remote/remote-desktop-protocol.ts), kept as raw
    /// JSON so a multi-megabyte state is framed without being parsed and re-encoded.
    #[ts(type = "unknown")]
    pub event: Box<serde_json::value::RawValue>,
}

/// Host -> client pushes.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum HostEvent {
    /// The host is about to exit; clients should reconnect (and respawn) on their next call.
    ShuttingDown { reason: String },
    /// Batched output of a terminal this connection spawned or attached to.
    TerminalData { id: String, data: String },
    #[serde(rename_all = "camelCase")]
    TerminalExit { id: String, exit_code: Option<u32>, signal: Option<String> },
    /// A device called the remote desktop API; only the connection serving it receives this.
    #[serde(rename_all = "camelCase")]
    RemoteInvoke {
        request_id: u64,
        client_id: String,
        method: String,
        #[ts(type = "unknown[]")]
        args: serde_json::Value,
    },
}

/// The method table: name, params type, result type. `ts_bindings` turns it into `HostMethods`.
macro_rules! methods {
    ($($name:literal => $params:ty => $result:ty),* $(,)?) => {
        pub const METHODS: &[&str] = &[$($name),*];
        fn method_map(cfg: &ts_rs::Config) -> String {
            let mut s = String::from("export interface HostMethods {\n");
            $(s.push_str(&format!(
                "  \"{}\": {{ params: {}; result: {} }};\n",
                $name, <$params as TS>::name(cfg), <$result as TS>::name(cfg)
            ));)*
            s.push_str("}\n");
            s
        }
    };
}

methods! {
    "hello" => HelloParams => HelloResult,
    "status" => Empty => StatusResult,
    "shutdown" => ShutdownParams => ShutdownResult,
    "index.list" => ListParams => SessionList,
    "session.context" => ContextParams => SessionContext,
    "session.slice" => SliceParams => SessionSlice,
    "session.tail" => TailParams => SessionTail,
    "terminal.spawn" => TerminalSpawnParams => TerminalSnapshot,
    "terminal.attach" => TerminalId => TerminalSnapshot,
    "terminal.detach" => TerminalId => Empty,
    "terminal.write" => TerminalWriteParams => Empty,
    "terminal.resize" => TerminalResizeParams => Empty,
    "terminal.kill" => TerminalId => Empty,
    "terminal.list" => Empty => TerminalList,
    "review.create" => crate::review_types::ReviewCreateParams => crate::review_types::ReviewCreateResult,
    "review.check" => crate::review_types::ReviewFileParams => crate::review_types::ReviewCheckResult,
    "review.read" => crate::review_types::ReviewFileParams => crate::review_types::ReviewReadResult,
    "review.stage" => crate::review_types::ReviewStageParams => crate::review_types::ReviewStageResult,
    "review.treeChanges" => crate::review_types::TreeChangesParams => crate::review_types::TreeChanges,
    "remote.serve" => RemoteServeParams => Empty,
    "remote.reply" => RemoteReplyParams => Empty,
    "remote.publish" => RemotePublishParams => Empty,
    "remote.stop" => Empty => Empty,
    "usage.scan" => Empty => crate::usage::UsageScan,
}

/// The whole generated TypeScript module.
pub fn ts_bindings() -> String {
    let cfg = ts_rs::Config::new().with_large_int("number");
    let decls = [
        ErrorCode::decl(&cfg),
        HostError::decl(&cfg),
        Empty::decl(&cfg),
        HelloParams::decl(&cfg),
        HelloResult::decl(&cfg),
        StatusResult::decl(&cfg),
        ShutdownParams::decl(&cfg),
        ShutdownResult::decl(&cfg),
        ListParams::decl(&cfg),
        SessionSummary::decl(&cfg),
        SessionList::decl(&cfg),
        ContextParams::decl(&cfg),
        SessionContext::decl(&cfg),
        SliceParams::decl(&cfg),
        SessionSlice::decl(&cfg),
        TailParams::decl(&cfg),
        SessionTail::decl(&cfg),
        TerminalStatus::decl(&cfg),
        TerminalSpawnParams::decl(&cfg),
        TerminalInfo::decl(&cfg),
        TerminalId::decl(&cfg),
        TerminalSnapshot::decl(&cfg),
        TerminalWriteParams::decl(&cfg),
        TerminalResizeParams::decl(&cfg),
        TerminalList::decl(&cfg),
        RemoteClientConfig::decl(&cfg),
        RemoteServeParams::decl(&cfg),
        RemoteError::decl(&cfg),
        RemoteReplyParams::decl(&cfg),
        RemotePublishParams::decl(&cfg),
        HostEvent::decl(&cfg),
    ];
    use crate::review_types as rv;
    let review = [
        rv::CoverageState::decl(&cfg),
        rv::ReviewCoverage::decl(&cfg),
        rv::IssueState::decl(&cfg),
        rv::ReviewIssue::decl(&cfg),
        rv::ReviewFileStatus::decl(&cfg),
        rv::ReviewLineCounts::decl(&cfg),
        rv::ReviewScope::decl(&cfg),
        rv::GitReviewScope::decl(&cfg),
        rv::BlobRef::decl(&cfg),
        rv::WorkingState::decl(&cfg),
        rv::FileSource::decl(&cfg),
        rv::GitReviewFile::decl(&cfg),
        rv::ReviewBaseOption::decl(&cfg),
        rv::AvailableState::decl(&cfg),
        rv::GitReviewSnapshot::decl(&cfg),
        rv::ReviewCreateResult::decl(&cfg),
        rv::GitReviewFileContent::decl(&cfg),
        rv::ReviewReadResult::decl(&cfg),
        rv::AppliedState::decl(&cfg),
        rv::StageApplied::decl(&cfg),
        rv::ReviewStageResult::decl(&cfg),
        rv::TurnChangedFile::decl(&cfg),
        rv::ReviewCreateParams::decl(&cfg),
        rv::ReviewFileParams::decl(&cfg),
        rv::StageAction::decl(&cfg),
        rv::ReviewStageParams::decl(&cfg),
        rv::TreeChangesParams::decl(&cfg),
        rv::TreeChanges::decl(&cfg),
        rv::ReviewCheckResult::decl(&cfg),
    ];
    use crate::usage as us;
    let usage = [
        us::UsageMessage::decl(&cfg),
        us::UsageEntry::decl(&cfg),
        us::UsageSession::decl(&cfg),
        us::UsageScan::decl(&cfg),
    ];
    let decls: Vec<String> = decls.into_iter().chain(review).chain(usage).collect();
    let mut out = String::from(
        "// GENERATED by crates/pegasus-core/src/protocol.rs. Do not edit; run `corepack pnpm protocol:emit`.\n\
         import type { SessionEntry } from \"@earendil-works/pi-coding-agent\";\n\n",
    );
    out.push_str(&format!("export const HOST_PROTOCOL = {PROTOCOL};\n\n"));
    out.push_str("/** pi's own session entry, passed through unparsed. */\nexport type RawEntry = SessionEntry;\n\n");
    for d in decls {
        out.push_str("export ");
        out.push_str(d.trim());
        out.push_str("\n\n");
    }
    out.push_str(&method_map(&cfg));
    out
}
