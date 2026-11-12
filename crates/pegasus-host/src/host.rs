//! Shared host state and request dispatch. One `Host` per process; each connection calls `dispatch`.
use crate::terminals::Terminals;
use pegasus_core::protocol::{
    Empty, ErrorCode, HelloParams, HelloResult, HostError, HostEvent, ShutdownParams, ShutdownResult,
    StatusResult, TerminalId, TerminalList, TerminalResizeParams, TerminalSpawnParams, TerminalWriteParams,
    PROTOCOL,
};
use std::collections::HashSet;
use pegasus_core::rpc::Server as Sessions;
use serde::Deserialize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, watch};

/// The app version this binary was built for (release builds set PEGASUS_APP_VERSION). Clients
/// replace a host whose version differs from their own.
pub const HOST_VERSION: &str = match option_env!("PEGASUS_APP_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

/// Per-connection context: the client's name and which terminals' output it receives.
#[derive(Default)]
pub struct Conn {
    pub id: u64,
    /// This connection serves the remote desktop API (receives `remoteInvoke`).
    pub remote_provider: std::sync::atomic::AtomicBool,
    pub name: Mutex<String>,
    pub subs: Mutex<HashSet<String>>,
}

impl Conn {
    pub fn name(&self) -> String {
        self.name.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// Terminal events go only to subscribed connections; everything else to all.
    pub fn wants(&self, e: &HostEvent) -> bool {
        match e {
            HostEvent::TerminalData { id, .. } | HostEvent::TerminalExit { id, .. } => {
                self.subs.lock().unwrap_or_else(|p| p.into_inner()).contains(id)
            }
            HostEvent::ShuttingDown { .. } => true,
            HostEvent::RemoteInvoke { .. } => self.remote_provider.load(std::sync::atomic::Ordering::SeqCst),
        }
    }
    /// Returns whether the set changed.
    fn sub(&self, id: &str, on: bool) -> bool {
        let mut s = self.subs.lock().unwrap_or_else(|p| p.into_inner());
        if on { s.insert(id.to_string()) } else { s.remove(id) }
    }
}

pub struct Host {
    sessions: Arc<Mutex<Sessions>>,
    /// Usage scans the same root with its own lock, so a long first scan never blocks session reads.
    usage: Arc<pegasus_core::usage::UsageIndex>,
    sessions_root: std::path::PathBuf,
    clients: AtomicU32,
    pub terminals: Arc<Terminals>,
    pub remote: Arc<crate::remote::Remote>,
    /// How long an orphaned terminal waits for a client before it is killed.
    pub orphan_grace: std::time::Duration,
    started: Instant,
    started_ms: f64,
    /// Last time the client count changed; drives the idle exit.
    last_change: Mutex<Instant>,
    pub events: broadcast::Sender<HostEvent>,
    /// `true` once a shutdown is accepted; main exits on it.
    pub exiting: watch::Sender<bool>,
    /// The supervisor task owns the Node runtime worker and restarts it after a crash.
    _runtime_worker: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    v: u32,
    id: u64,
    method: String,
    #[serde(default)]
    params: Option<Box<serde_json::value::RawValue>>,
}

type Reply = Result<Vec<u8>, HostError>;

/// A call at least this slow becomes a `host.call.slow` event (the UI waits on most calls).
const SLOW_CALL_MS: u64 = 250;

/// Params stay raw JSON until the method knows its type, so large payloads are parsed once.
type Params = Option<Box<serde_json::value::RawValue>>;

fn parse<T: serde::de::DeserializeOwned>(raw: Params) -> Result<T, HostError> {
    let text = raw.as_deref().map_or("{}", |r| r.get());
    let text = if text.trim() == "null" { "{}" } else { text };
    serde_json::from_str(text).map_err(|e| HostError::new(ErrorCode::BadParams, e.to_string()))
}

fn to_body<T: serde::Serialize>(v: &T) -> Reply {
    serde_json::to_vec(v).map_err(|e| HostError::new(ErrorCode::Internal, e.to_string()))
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

impl Host {
    pub fn new(
        sessions: Sessions,
        usage: pegasus_core::usage::UsageIndex,
        orphan_grace: std::time::Duration,
        log_dir: Option<&std::path::Path>,
    ) -> Arc<Self> {
        let events = broadcast::channel(1024).0;
        let sessions_root = sessions.root().to_path_buf();
        let (exiting, exit_rx) = watch::channel(false);
        let runtime_worker = crate::runtime::RuntimeWorker::start(log_dir, exit_rx);
        Arc::new(Host {
            sessions: Arc::new(Mutex::new(sessions)),
            usage: Arc::new(usage),
            sessions_root,
            clients: AtomicU32::new(0),
            terminals: Arc::new(Terminals::new(events.clone())),
            remote: Arc::new(crate::remote::Remote::default()),
            orphan_grace,
            started: Instant::now(),
            started_ms: now_ms(),
            last_change: Mutex::new(Instant::now()),
            events,
            exiting,
            _runtime_worker: runtime_worker,
        })
    }

    fn active_work(&self) -> u32 {
        self.terminals.running()
    }

    pub fn client_connected(&self) -> u32 {
        *self.last_change.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        self.clients.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn client_left(&self) -> u32 {
        *self.last_change.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        self.clients.fetch_sub(1, Ordering::SeqCst) - 1
    }

    /// Idle = no clients, no protected work, and nothing changed for `idle`.
    pub fn idle_for(&self, idle: std::time::Duration) -> bool {
        self.clients.load(Ordering::SeqCst) == 0
            && self.active_work() == 0
            && self.last_change.lock().unwrap_or_else(|p| p.into_inner()).elapsed() >= idle
    }

    pub fn begin_exit(&self, reason: &str) {
        crate::info!("exiting: {reason}");
        let _ = self.events.send(HostEvent::ShuttingDown { reason: reason.to_string() });
        self.terminals.kill_all();
        let _ = self.exiting.send(true);
    }

    /// One request body in, one framed response body out. Errors are responses, never panics.
    pub async fn dispatch(self: &Arc<Self>, body: &[u8], conn: &Conn) -> Vec<u8> {
        let req: Request = match serde_json::from_slice(body) {
            Ok(r) => r,
            Err(e) => return envelope(0, Err(HostError::new(ErrorCode::BadRequest, e.to_string()))),
        };
        let started = Instant::now();
        let reply = if req.v != PROTOCOL {
            Err(HostError::new(ErrorCode::UnsupportedProtocol, format!("host speaks v{PROTOCOL}, client sent v{}", req.v)))
        } else if *self.exiting.borrow() {
            Err(HostError::new(ErrorCode::ShuttingDown, "host is exiting"))
        } else {
            self.call(&req.method, req.params, conn).await
        };
        let ms = started.elapsed().as_millis() as u64;
        if let Err(e) = &reply {
            crate::log::text("WARN", &format!("{} {} #{} -> {e}", conn.name(), req.method, req.id));
            crate::log::event(
                "host.call.error",
                Some("e"),
                [
                    ("m", req.method.as_str().into()),
                    ("ms", ms.into()),
                    ("code", serde_json::to_value(e.code).unwrap_or_default()),
                    ("msg", e.message.as_str().into()),
                    ("conn", conn.name().into()),
                ],
            );
        } else if ms >= SLOW_CALL_MS {
            crate::log::event(
                "host.call.slow",
                Some("w"),
                [("m", req.method.as_str().into()), ("ms", ms.into()), ("bytes", reply.as_ref().map_or(0, |b| b.len()).into())],
            );
        }
        envelope(req.id, reply)
    }

    async fn call(self: &Arc<Self>, method: &str, params: Params, conn: &Conn) -> Reply {
        let client = conn.name();
        match method {
            "hello" => {
                let p: HelloParams = parse(params)?;
                crate::info!("{} {} attached (host {HOST_VERSION})", p.client, p.app_version);
                *conn.name.lock().unwrap_or_else(|e| e.into_inner()) = format!("{}@{}", p.client, p.app_version);
                to_body(&HelloResult {
                    protocol: PROTOCOL,
                    host_version: HOST_VERSION.into(),
                    pid: std::process::id(),
                    started_ms: self.started_ms,
                })
            }
            "status" => {
                let _: Empty = parse(params)?;
                to_body(&StatusResult {
                    pid: std::process::id(),
                    host_version: HOST_VERSION.into(),
                    uptime_ms: self.started.elapsed().as_secs_f64() * 1000.0,
                    clients: self.clients.load(Ordering::SeqCst),
                    active_work: self.active_work(),
                })
            }
            "shutdown" => {
                let p: ShutdownParams = parse(params)?;
                let active_work = self.active_work();
                let accepted = p.force || active_work == 0;
                if accepted {
                    let host = self.clone();
                    let reason = format!("{client}: {}", p.reason);
                    // Reply first, then exit.
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        host.begin_exit(&reason);
                    });
                } else {
                    crate::info!("{client} shutdown refused: {active_work} active ({})", p.reason);
                }
                to_body(&ShutdownResult { accepted, active_work })
            }
            "index.list" | "session.context" | "session.slice" | "session.tail" => {
                let sessions = self.sessions.clone();
                let method = method.to_string();
                tokio::task::spawn_blocking(move || {
                    let mut s = sessions.lock().map_err(|_| HostError::new(ErrorCode::Internal, "session store lock poisoned"))?;
                    let params: serde_json::Value = parse(params)?;
                    s.call(&method, &params).map_err(|(code, msg)| HostError::new(code, msg))
                })
                .await
                .map_err(|e| HostError::new(ErrorCode::Internal, format!("session task failed: {e}")))?
            }
            "terminal.spawn" => {
                let p: TerminalSpawnParams = parse(params)?;
                let id = p.id.clone();
                // Subscribe before the process can print, so no early output is missed; a failed
                // spawn undoes only a subscription it added (a duplicate id keeps the existing one).
                let added = conn.sub(&id, true);
                let r = self.terminals.spawn(p, conn.id);
                if r.is_err() && added {
                    conn.sub(&id, false);
                }
                to_body(&r?)
            }
            "terminal.attach" => {
                let p: TerminalId = parse(params)?;
                conn.sub(&p.id, true);
                // Snapshot after subscribing: output may repeat across the seam, but none is lost.
                to_body(&self.terminals.attach(&p.id, conn.id)?)
            }
            "terminal.detach" => {
                let p: TerminalId = parse(params)?;
                conn.sub(&p.id, false);
                to_body(&Empty {})
            }
            "terminal.write" => {
                let p: TerminalWriteParams = parse(params)?;
                self.terminals.write(&p.id, &p.data)?;
                to_body(&Empty {})
            }
            "terminal.resize" => {
                let p: TerminalResizeParams = parse(params)?;
                self.terminals.resize(&p.id, p.cols, p.rows)?;
                to_body(&Empty {})
            }
            "terminal.kill" => {
                let p: TerminalId = parse(params)?;
                self.terminals.kill(&p.id)?;
                conn.sub(&p.id, false);
                to_body(&Empty {})
            }
            "terminal.list" => {
                let _: Empty = parse(params)?;
                to_body(&TerminalList { terminals: self.terminals.list() })
            }
            "review.create" | "review.check" | "review.read" | "review.stage" | "review.treeChanges" => {
                let method = method.to_string();
                tokio::task::spawn_blocking(move || review_call(&method, params))
                    .await
                    .map_err(|e| HostError::new(ErrorCode::Internal, format!("review task failed: {e}")))?
            }
            "usage.scan" => {
                let _: Empty = parse(params)?;
                let (usage, root) = (self.usage.clone(), self.sessions_root.clone());
                tokio::task::spawn_blocking(move || {
                    let started = Instant::now();
                    let scan = usage.scan_root(&root);
                    crate::info!(
                        "usage scan: {} sessions, {} unreadable, {} ms",
                        scan.sessions.len(),
                        scan.unreadable,
                        started.elapsed().as_millis()
                    );
                    to_body(&scan)
                })
                .await
                .map_err(|e| HostError::new(ErrorCode::Internal, format!("usage task failed: {e}")))?
            }
            "remote.serve" => {
                let p: pegasus_core::protocol::RemoteServeParams = parse(params)?;
                self.remote.serve(self, p, conn.id).await?;
                conn.remote_provider.store(true, std::sync::atomic::Ordering::SeqCst);
                to_body(&Empty {})
            }
            "remote.reply" => {
                let p: pegasus_core::protocol::RemoteReplyParams = parse(params)?;
                self.remote.reply(p)?;
                to_body(&Empty {})
            }
            "remote.publish" => {
                let p: pegasus_core::protocol::RemotePublishParams = parse(params)?;
                if !self.remote.is_provider(conn.id) {
                    return Err(HostError::new(ErrorCode::BadParams, "only the serving connection publishes"));
                }
                let delivered = self.remote.publish(&p.client_id, &p.event);
                to_body(&pegasus_core::protocol::RemotePublishResult { delivered })
            }
            "remote.stop" => {
                let _: Empty = parse(params)?;
                if self.remote.is_provider(conn.id) {
                    self.remote.stop();
                }
                conn.remote_provider.store(false, std::sync::atomic::Ordering::SeqCst);
                to_body(&Empty {})
            }
            other => Err(HostError::new(ErrorCode::UnknownMethod, other)),
        }
    }
}

/// Git review runs blocking Git commands, so it stays off the async workers.
fn review_call(method: &str, params: Params) -> Reply {
    use pegasus_core::review_types::{ReviewCheckResult, ReviewCreateParams, ReviewFileParams, ReviewStageParams, TreeChangesParams};
    match method {
        "review.create" => to_body(&crate::review::create(parse::<ReviewCreateParams>(params)?)),
        "review.check" => {
            let p: ReviewFileParams = parse(params)?;
            let issue = match crate::review::snapshot(&p.snapshot_id) {
                Ok(s) => crate::review::check_current(&s, &p.file_id),
                Err(expired) => Some(expired),
            };
            to_body(&ReviewCheckResult { issue })
        }
        "review.read" => {
            let p: ReviewFileParams = parse(params)?;
            match crate::review::snapshot(&p.snapshot_id) {
                Ok(s) => to_body(&crate::review::read_file(&s, &p.file_id)),
                Err(expired) => to_body(&pegasus_core::review_types::ReviewReadResult::Issue(expired)),
            }
        }
        "review.stage" => {
            let p: ReviewStageParams = parse(params)?;
            match crate::review::snapshot(&p.snapshot_id) {
                Ok(s) => to_body(&crate::review::stage(&s, &p.file_id, p.action)),
                Err(expired) => to_body(&pegasus_core::review_types::ReviewStageResult::Issue(expired)),
            }
        }
        "review.treeChanges" => {
            let p: TreeChangesParams = parse(params)?;
            let r = crate::review::tree_changes(p).map_err(|e| HostError::new(ErrorCode::Io, e))?;
            to_body(&r)
        }
        other => Err(HostError::new(ErrorCode::UnknownMethod, other)),
    }
}

/// `{"v":2,"id":N,"result":<body>}` without re-parsing the (possibly large) result body.
fn envelope(id: u64, reply: Reply) -> Vec<u8> {
    match reply {
        Ok(body) => {
            let mut out = format!(r#"{{"v":{PROTOCOL},"id":{id},"result":"#).into_bytes();
            out.extend_from_slice(&body);
            out.push(b'}');
            out
        }
        Err(e) => serde_json::to_vec(&serde_json::json!({ "v": PROTOCOL, "id": id, "error": e }))
            .unwrap_or_else(|_| br#"{"v":2,"id":0,"error":{"code":"internal","message":"encode"}}"#.to_vec()),
    }
}

pub fn event_frame(e: &HostEvent) -> Vec<u8> {
    let mut v = serde_json::to_value(e).unwrap_or_default();
    if let Some(o) = v.as_object_mut() {
        o.insert("v".into(), PROTOCOL.into());
    }
    serde_json::to_vec(&v).unwrap_or_default()
}
