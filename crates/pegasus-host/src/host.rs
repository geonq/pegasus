//! Shared host state and request dispatch. One `Host` per process; each connection calls `dispatch`.
use pegasus_core::protocol::{
    Empty, ErrorCode, HelloParams, HelloResult, HostError, HostEvent, ShutdownParams, ShutdownResult,
    StatusResult, PROTOCOL,
};
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

pub struct Host {
    sessions: Arc<Mutex<Sessions>>,
    clients: AtomicU32,
    active_work: AtomicU32,
    started: Instant,
    started_ms: f64,
    /// Last time the client count changed; drives the idle exit.
    last_change: Mutex<Instant>,
    pub events: broadcast::Sender<HostEvent>,
    /// `true` once a shutdown is accepted; main exits on it.
    pub exiting: watch::Sender<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    v: u32,
    id: u64,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

type Reply = Result<Vec<u8>, HostError>;

fn parse<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<T, HostError> {
    let v = if v.is_null() { serde_json::json!({}) } else { v };
    serde_json::from_value(v).map_err(|e| HostError::new(ErrorCode::BadParams, e.to_string()))
}

fn to_body<T: serde::Serialize>(v: &T) -> Reply {
    serde_json::to_vec(v).map_err(|e| HostError::new(ErrorCode::Internal, e.to_string()))
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

impl Host {
    pub fn new(sessions: Sessions) -> Arc<Self> {
        Arc::new(Host {
            sessions: Arc::new(Mutex::new(sessions)),
            clients: AtomicU32::new(0),
            active_work: AtomicU32::new(0),
            started: Instant::now(),
            started_ms: now_ms(),
            last_change: Mutex::new(Instant::now()),
            events: broadcast::channel(64).0,
            exiting: watch::channel(false).0,
        })
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
            && self.active_work.load(Ordering::SeqCst) == 0
            && self.last_change.lock().unwrap_or_else(|p| p.into_inner()).elapsed() >= idle
    }

    pub fn begin_exit(&self, reason: &str) {
        crate::info!("exiting: {reason}");
        let _ = self.events.send(HostEvent::ShuttingDown { reason: reason.to_string() });
        let _ = self.exiting.send(true);
    }

    /// One request body in, one framed response body out. Errors are responses, never panics.
    pub async fn dispatch(self: &Arc<Self>, body: &[u8], client: &mut String) -> Vec<u8> {
        let req: Request = match serde_json::from_slice(body) {
            Ok(r) => r,
            Err(e) => return envelope(0, Err(HostError::new(ErrorCode::BadRequest, e.to_string()))),
        };
        let reply = if req.v != PROTOCOL {
            Err(HostError::new(ErrorCode::UnsupportedProtocol, format!("host speaks v{PROTOCOL}, client sent v{}", req.v)))
        } else if *self.exiting.borrow() {
            Err(HostError::new(ErrorCode::ShuttingDown, "host is exiting"))
        } else {
            self.call(&req.method, req.params, client).await
        };
        if let Err(e) = &reply {
            crate::warn!("{client} {} #{} -> {e}", req.method, req.id);
        }
        envelope(req.id, reply)
    }

    async fn call(self: &Arc<Self>, method: &str, params: serde_json::Value, client: &mut String) -> Reply {
        match method {
            "hello" => {
                let p: HelloParams = parse(params)?;
                crate::info!("{} {} attached (host {HOST_VERSION})", p.client, p.app_version);
                *client = format!("{}@{}", p.client, p.app_version);
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
                    active_work: self.active_work.load(Ordering::SeqCst),
                })
            }
            "shutdown" => {
                let p: ShutdownParams = parse(params)?;
                let active_work = self.active_work.load(Ordering::SeqCst);
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
                    s.call(&method, &params).map_err(|(code, msg)| HostError::new(code, msg))
                })
                .await
                .map_err(|e| HostError::new(ErrorCode::Internal, format!("session task failed: {e}")))?
            }
            other => Err(HostError::new(ErrorCode::UnknownMethod, other)),
        }
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
