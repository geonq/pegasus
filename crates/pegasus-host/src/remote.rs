//! Remote desktop API for other devices (the Mac client today, the phone next), ported from
//! apps/desktop/electron/remote/remote-desktop-http-host.ts with the same wire format:
//!   POST /v1/invoke  {method, args} -> {"version":1,"result":..} | {"version":1,"error":{code,message}}
//!   GET  /v1/events  text/event-stream: `ready`, then stateChanged / selectedTranscriptChanged / terminal*
//! Requests are relayed to Electron's per-device broker over the host connection that called
//! `remote.serve` (a `remoteInvoke` event, answered with `remote.reply`); events arrive through
//! `remote.publish`. Serialization, Brotli and stream bookkeeping run here, off Electron's main thread.
use crate::host::Host;
use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use pegasus_core::protocol::{ErrorCode, HostError, HostEvent, RemoteError, RemoteReplyParams, RemoteServeParams};
use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Notify};

const MAX_BODY_BYTES: usize = 48 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 24 * 1024 * 1024;
const MAX_SSE_STREAMS: usize = 32;
const MAX_SSE_PER_CLIENT: usize = 4;
const MAX_SSE_BUFFER_BYTES: usize = 24 * 1024 * 1024;
const MAX_SSE_QUEUED_FRAMES: usize = 64 + 2;
const HEARTBEAT: Duration = Duration::from_secs(15);
const MIN_COMPRESSED_BYTES: usize = 2048;
const INVOKE_TIMEOUT: Duration = Duration::from_secs(70);

type Body = BoxBody<Bytes, Infallible>;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Clone)]
struct SseFrame {
    is_state: bool,
    text: Arc<String>,
    revision: Option<f64>,
}

struct StreamState {
    initializing: bool,
    queue: VecDeque<SseFrame>,
    queued_bytes: usize,
    in_flight: usize,
    highest_rev: Option<f64>,
    last_sent_rev: Option<f64>,
    closed: bool,
}

struct SseStream {
    client_id: String,
    state: Mutex<StreamState>,
    wake: Notify,
    /// Bytes handed to the HTTP body but not yet taken by hyper (a paused client stops taking).
    in_body: Arc<std::sync::atomic::AtomicUsize>,
    /// Drops this stream's HTTP connection; a paused client never reads, so only that frees it.
    kill: Arc<Notify>,
}

impl SseStream {
    fn pending_bytes(&self, st: &StreamState) -> usize {
        st.queued_bytes + st.in_flight + self.in_body.load(Ordering::SeqCst)
    }
}

impl SseStream {
    fn close(&self) {
        lock(&self.state).closed = true;
        self.wake.notify_one();
    }
    /// Like the TS host's destroyStream: close and drop the connection at once.
    fn abort(&self) {
        crate::info!("sse stream for {} aborted (byte or frame cap, or a broken frame)", self.client_id);
        self.close();
        self.kill.notify_one();
    }
}

struct Server {
    /// Host headers this server answers to: `127.0.0.1:port` and each extra bind.
    hosts: HashSet<String>,
    origins: HashSet<String>,
    /// sha256(token) hex -> client id
    clients: HashMap<String, String>,
    stop: Arc<Notify>,
}

pub struct Remote {
    server: Mutex<Option<Arc<Server>>>,
    /// Host connection that serves remote calls (Electron main).
    provider: Mutex<Option<u64>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<RemoteReplyParams>>>,
    next_request: AtomicU64,
    streams: Mutex<Vec<Arc<SseStream>>>,
    event_sequence: AtomicU64,
}

impl Default for Remote {
    fn default() -> Self {
        Remote {
            server: Mutex::new(None),
            provider: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(1),
            streams: Mutex::new(Vec::new()),
            event_sequence: AtomicU64::new(1),
        }
    }
}

fn host_err(msg: impl Into<String>) -> HostError {
    HostError::new(ErrorCode::BadParams, msg)
}

fn valid_origin(o: &str) -> bool {
    if o == "file://" {
        return true;
    }
    let rest = o.strip_prefix("http://").or_else(|| o.strip_prefix("https://"));
    match rest.and_then(|r| r.strip_prefix("127.0.0.1")) {
        Some("") => true,
        Some(port) => port.strip_prefix(':').is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

impl Remote {
    pub fn is_provider(&self, conn: u64) -> bool {
        *lock(&self.provider) == Some(conn)
    }

    /// Start (or replace) the loopback server. The calling connection becomes the provider.
    pub async fn serve(self: &Arc<Self>, host: &Arc<Host>, p: RemoteServeParams, conn: u64) -> Result<(), HostError> {
        if p.allowed_origins.is_empty() {
            return Err(host_err("Remote desktop origins are required."));
        }
        if p.allowed_origins.iter().any(|o| o.len() > 256 || !valid_origin(o)) {
            return Err(host_err("Remote desktop origins must be exact file or loopback origins."));
        }
        if p.clients.is_empty() {
            return Err(host_err("At least one remote desktop client is required."));
        }
        let mut clients = HashMap::new();
        let mut ids = HashSet::new();
        for c in &p.clients {
            let digest_ok = c.token_sha256.len() == 64 && c.token_sha256.bytes().all(|b| b.is_ascii_hexdigit());
            if c.id.is_empty() || c.id.len() > 256 || c.id.contains('\0') || !ids.insert(c.id.clone()) {
                return Err(host_err("Remote desktop client IDs must be unique."));
            }
            if !digest_ok || clients.insert(c.token_sha256.to_ascii_lowercase(), c.id.clone()).is_some() {
                return Err(host_err("Remote desktop tokens must be unique."));
            }
        }
        let mut addrs: Vec<std::net::Ipv4Addr> = vec![std::net::Ipv4Addr::LOCALHOST];
        for b in p.extra_binds.iter().flatten() {
            let ip: std::net::Ipv4Addr = b.parse().map_err(|_| host_err(format!("not an IPv4 address: {b}")))?;
            // Only the Tailscale range (100.64.0.0/10): never every interface, never the LAN by accident.
            let o = ip.octets();
            if !(o[0] == 100 && (64..128).contains(&o[1])) {
                return Err(host_err(format!("{b} is not a Tailscale address (100.64.0.0/10)")));
            }
            if !addrs.contains(&ip) {
                addrs.push(ip);
            }
        }
        self.stop();
        let mut listeners = Vec::new();
        for ip in &addrs {
            let l = tokio::net::TcpListener::bind((*ip, p.port))
                .await
                .map_err(|e| HostError::new(ErrorCode::Io, format!("remote {ip}:{}: {e}", p.port)))?;
            listeners.push(l);
        }
        let server = Arc::new(Server {
            hosts: addrs.iter().map(|ip| format!("{ip}:{}", p.port)).collect(),
            origins: p.allowed_origins.into_iter().collect(),
            clients,
            stop: Arc::new(Notify::new()),
        });
        *lock(&self.server) = Some(server.clone());
        *lock(&self.provider) = Some(conn);
        for listener in listeners {
            self.accept_loop(host, server.clone(), listener);
        }
        Ok(())
    }

    fn accept_loop(self: &Arc<Self>, host: &Arc<Host>, server: Arc<Server>, listener: tokio::net::TcpListener) {
        let (me, host) = (self.clone(), host.clone());
        tokio::spawn(async move {
            let at = listener.local_addr().map(|a| a.to_string()).unwrap_or_default();
            crate::info!("remote desktop API on {at}");
            loop {
                let accepted = tokio::select! {
                    a = listener.accept() => a,
                    _ = server.stop.notified() => {
                        // Wake the other listeners of this server too.
                        server.stop.notify_waiters();
                        break;
                    }
                };
                let Ok((tcp, _)) = accepted else { continue };
                let (me, server, host) = (me.clone(), server.clone(), host.clone());
                tokio::spawn(async move {
                    // A second handle to the socket, so an aborted stream can be reset (RST) even
                    // while hyper owns the connection and a paused client has megabytes queued.
                    let Ok(std_tcp) = tcp.into_std() else { return };
                    let Ok(reset_handle) = std_tcp.try_clone() else { return };
                    let Ok(tcp) = tokio::net::TcpStream::from_std(std_tcp) else { return };
                    let io = hyper_util::rt::TokioIo::new(tcp);
                    let kill = Arc::new(Notify::new());
                    let kill_for_service = kill.clone();
                    let service = hyper::service::service_fn(move |req| {
                        let (me, server, host, kill) = (me.clone(), server.clone(), host.clone(), kill_for_service.clone());
                        async move { Ok::<_, Infallible>(me.handle(&host, &server, req, kill).await) }
                    });
                    let conn = hyper::server::conn::http1::Builder::new()
                        .timer(hyper_util::rt::TokioTimer::new())
                        .max_buf_size(64 * 1024)
                        .header_read_timeout(Duration::from_secs(10))
                        .serve_connection(io, service);
                    tokio::select! {
                        _ = conn => {}
                        _ = kill.notified() => {
                            crate::info!("remote connection reset");
                            // Like Node's destroy(): drop what is queued instead of draining it.
                            let _ = socket2::SockRef::from(&reset_handle).set_linger(Some(Duration::ZERO));
                        }
                    }
                    drop(reset_handle);
                });
            }
            crate::info!("remote desktop API on {at} stopped");
        });
    }

    pub fn stop(&self) {
        if let Some(s) = lock(&self.server).take() {
            s.stop.notify_waiters();
            s.stop.notify_one();
        }
        for s in lock(&self.streams).drain(..) {
            s.close();
        }
        for (_, tx) in lock(&self.pending).drain() {
            let _ = tx.send(RemoteReplyParams {
                request_id: 0,
                ok: false,
                value: None,
                error: Some(RemoteError { status: 503, code: "host_stopped".into(), message: "The remote desktop host stopped.".into() }),
            });
        }
        *lock(&self.provider) = None;
    }

    /// The provider went away: stop serving (devices see the stream end and reconnect later).
    pub fn connection_closed(&self, conn: u64) {
        if self.is_provider(conn) {
            crate::info!("remote provider disconnected; stopping the remote desktop API");
            self.stop();
        }
    }

    pub fn reply(&self, r: RemoteReplyParams) -> Result<(), HostError> {
        let tx = lock(&self.pending)
            .remove(&r.request_id)
            .ok_or_else(|| HostError::new(ErrorCode::NotFound, format!("no pending remote request {}", r.request_id)))?;
        let _ = tx.send(r);
        Ok(())
    }

    async fn invoke(&self, host: &Host, client_id: &str, method: &str, args: serde_json::Value) -> RemoteReplyParams {
        let request_id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(request_id, tx);
        let _ = host.events.send(HostEvent::RemoteInvoke {
            request_id,
            client_id: client_id.into(),
            method: method.into(),
            args,
        });
        match tokio::time::timeout(INVOKE_TIMEOUT, rx).await {
            Ok(Ok(r)) => r,
            _ => {
                lock(&self.pending).remove(&request_id);
                RemoteReplyParams {
                    request_id,
                    ok: false,
                    value: None,
                    error: Some(RemoteError {
                        status: 504,
                        code: "operation_timed_out".into(),
                        message: "The remote native operation did not answer in time.".into(),
                    }),
                }
            }
        }
    }

    // ---------- events ----------

    /// Queues the event on the client's open streams; false when it has none (nobody listens).
    pub fn publish(&self, client_id: &str, event: &serde_json::value::RawValue) -> bool {
        let recipients: Vec<Arc<SseStream>> = lock(&self.streams)
            .iter()
            .filter(|s| s.client_id == client_id && !lock(&s.state).closed)
            .cloned()
            .collect();
        if recipients.is_empty() {
            return false;
        }
        match frame_of(event) {
            Some(f) => recipients.iter().for_each(|s| enqueue(s, f.clone())),
            None => recipients.iter().for_each(|s| s.abort()),
        }
        true
    }

    // ---------- http ----------

    async fn handle(self: &Arc<Self>, host: &Arc<Host>, server: &Arc<Server>, req: Request<Incoming>, kill: Arc<Notify>) -> Response<Body> {
        let (parts, body) = req.into_parts();
        let early = self.route(host, server, parts, body, kill).await;
        match early {
            Routed::Done(r) => r,
            Routed::Drain(body, r) => {
                drain(body).await;
                r
            }
        }
    }

    async fn route(self: &Arc<Self>, host: &Arc<Host>, server: &Arc<Server>, parts: hyper::http::request::Parts, body: Incoming, kill: Arc<Notify>) -> Routed {
        let req = Request::from_parts(parts, ());
        let headers = req.headers().clone();
        macro_rules! early {
            ($r:expr) => {
                Routed::Drain(body, $r)
            };
        }
        if !header(&headers, "host").is_some_and(|h| server.hosts.contains(h)) {
            crate::info!("remote request with Host {:?}; allowed {:?}", header(&headers, "host"), server.hosts);
            return early!(error(400, "invalid_host", "The loopback Host header is invalid.", None));
        }
        // Browsers always send Origin on these requests, so a present one must be allowed. A native
        // app (the phone) sends none; it still needs its bearer token.
        let origin = match header(&headers, "origin") {
            None => String::new(),
            Some(o) if server.origins.contains(o) => o.to_string(),
            Some(_) => return early!(error(403, "origin_denied", "The request origin is not allowed.", None)),
        };
        let Some(client_id) = authenticate(&headers, &server.clients) else {
            return early!(error(401, "unauthorized", "A valid bearer token is required.", Some(&origin)));
        };
        let uri = req.uri();
        if uri.query().is_some() || uri.authority().is_some() || !uri.path().starts_with('/') {
            return early!(error(400, "invalid_url", "The request URL is not allowed.", Some(&origin)));
        }
        let path = uri.path().to_string();
        let method = req.method().clone();
        if method == Method::POST && path == "/v1/invoke" {
            let brotli = accepts_brotli(&headers);
            return match self.handle_invoke(host, &client_id, &headers, body).await {
                Ok(value) => {
                    let raw = value.as_ref().map_or("null", |v| v.get());
                    let mut body = Vec::with_capacity(raw.len() + 24);
                    body.extend_from_slice(b"{\"version\":1,\"result\":");
                    body.extend_from_slice(raw.as_bytes());
                    body.push(b'}');
                    Routed::Done(json_response(200, body, brotli, &origin).await)
                }
                Err((status, code, message, rest)) => match rest {
                    Some(b) => Routed::Drain(b, error(status, &code, &message, Some(&origin))),
                    None => Routed::Done(error(status, &code, &message, Some(&origin))),
                },
            };
        }
        if method == Method::GET && path == "/v1/events" {
            let has_body = headers.contains_key("transfer-encoding") || header(&headers, "content-length").is_some_and(|l| l != "0");
            if has_body {
                return early!(error(400, "unexpected_body", "The event stream has no body.", Some(&origin)));
            }
            return Routed::Done(self.handle_events(host, &client_id, &headers, &origin, kill).await);
        }
        early!(error(404, "not_found", "The remote desktop route was not found.", Some(&origin)))
    }

    async fn handle_invoke(&self, host: &Host, client_id: &str, headers: &HeaderMap, body: Incoming) -> Result<Option<Box<serde_json::value::RawValue>>, (u16, String, String, Option<Incoming>)> {
        let fail = |s: u16, c: &str, m: &str| Err((s, c.to_string(), m.to_string(), None));
        let ct = header(headers, "content-type").unwrap_or("");
        if ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase() != "application/json" {
            return Err((415, "unsupported_media_type".into(), "Content-Type must be application/json.".into(), Some(body)));
        }
        if let Some(len) = header(headers, "content-length") {
            if !len.bytes().all(|b| b.is_ascii_digit()) || len.parse::<usize>().map_or(true, |n| n > MAX_BODY_BYTES) {
                return Err((413, "body_too_large".into(), "The request body exceeds its size limit.".into(), Some(body)));
            }
        }
        let body = match Limited::new(body, MAX_BODY_BYTES).collect().await {
            Ok(b) => b.to_bytes(),
            Err(_) => return fail(413, "body_too_large", "The request body exceeds its size limit."),
        };
        let value: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(v @ serde_json::Value::Object(_)) => v,
            _ => return fail(400, "invalid_json", "A JSON object is required."),
        };
        let obj = value.as_object().expect("checked object");
        if obj.keys().any(|k| k != "method" && k != "args") {
            return fail(400, "invalid_request", "The request contains an unsupported field.");
        }
        let (Some(method), Some(args)) = (obj.get("method").and_then(|m| m.as_str()), obj.get("args").filter(|a| a.is_array())) else {
            return fail(400, "invalid_request", "The remote method request is invalid.");
        };
        let r = self.invoke(host, client_id, method, args.clone()).await;
        if r.ok {
            Ok(r.value)
        } else {
            let e = r.error.unwrap_or(RemoteError { status: 400, code: "operation_failed".into(), message: "The remote native operation failed.".into() });
            Err((e.status, e.code, e.message, None))
        }
    }

    async fn handle_events(self: &Arc<Self>, host: &Arc<Host>, client_id: &str, headers: &HeaderMap, origin: &str, kill: Arc<Notify>) -> Response<Body> {
        if !header(headers, "accept").is_some_and(|a| a.split(',').any(|v| v.trim().starts_with("text/event-stream"))) {
            return error(406, "event_stream_required", "Accept: text/event-stream is required.", Some(origin));
        }
        let stream = {
            let mut streams = lock(&self.streams);
            streams.retain(|s| !lock(&s.state).closed);
            let mine = streams.iter().filter(|s| s.client_id == client_id).count();
            if streams.len() >= MAX_SSE_STREAMS || mine >= MAX_SSE_PER_CLIENT {
                return error(429, "too_many_event_streams", "The event-stream limit was reached.", Some(origin));
            }
            let s = Arc::new(SseStream {
                client_id: client_id.to_string(),
                state: Mutex::new(StreamState {
                    initializing: true,
                    queue: VecDeque::new(),
                    queued_bytes: 0,
                    in_flight: 0,
                    highest_rev: None,
                    last_sent_rev: None,
                    closed: false,
                }),
                wake: Notify::new(),
                in_body: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                kill,
            });
            streams.push(s.clone());
            s
        };
        crate::info!("sse stream opened for {client_id}");
        let brotli = accepts_brotli(headers);
        let (tx, rx) = mpsc::channel::<(Bytes, usize)>(1);
        let ready = format!("id: {}\nevent: ready\ndata: {{\"version\":1}}\n\n", self.event_sequence.fetch_add(1, Ordering::Relaxed));
        tokio::spawn(write_loop(self.clone(), stream.clone(), tx, brotli, ready));
        // Bootstrap: the current state and transcript go out before anything queued meanwhile.
        let (me, host2, cid, s2) = (self.clone(), host.clone(), client_id.to_string(), stream.clone());
        tokio::spawn(async move {
            let state = me.invoke(&host2, &cid, "getState", serde_json::json!([])).await;
            let transcript = me.invoke(&host2, &cid, "getSelectedTranscript", serde_json::json!([])).await;
            if !state.ok || !transcript.ok {
                s2.abort();
                return;
            }
            let mut frames = vec![];
            // A state only counts when it has a workspaces array (as the TS host checked).
            #[derive(serde::Deserialize)]
            struct Shape {
                workspaces: Option<serde_json::value::Value>,
            }
            let is_state = |raw: &serde_json::value::RawValue| {
                serde_json::from_str::<Shape>(raw.get()).ok().and_then(|s| s.workspaces).is_some_and(|w| w.is_array())
            };
            if let Some(st) = state.value.as_deref().filter(|v| is_state(v)) {
                match wrap_event("stateChanged", "state", st.get()).as_deref().and_then(frame_of) {
                    Some(f) => frames.push(f),
                    None => return s2.abort(),
                }
            }
            let tr = transcript.value.as_deref().map(|v| v.get()).filter(|t| t.trim_start().starts_with('{')).unwrap_or("null");
            match wrap_event("selectedTranscriptChanged", "transcript", tr).as_deref().and_then(frame_of) {
                Some(f) => frames.push(f),
                None => return s2.abort(),
            }
            bootstrap(&s2, frames);
        });
        let mut resp = Response::new(BoxBody::new(StreamBody::new(Counted { rx, in_body: stream.in_body.clone() })));
        let h = resp.headers_mut();
        h.insert("cache-control", HeaderValue::from_static("no-cache, no-transform"));
        h.insert("connection", HeaderValue::from_static("keep-alive"));
        h.insert("content-type", HeaderValue::from_static("text/event-stream; charset=utf-8"));
        h.insert("x-accel-buffering", HeaderValue::from_static("no"));
        h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
        cors(h, origin);
        if brotli {
            h.insert("content-encoding", HeaderValue::from_static("br"));
            h.insert("vary", HeaderValue::from_static("Origin, Accept-Encoding"));
        }
        resp
    }
}

// ---------- SSE queue (same rules as the TS host) ----------

/// An SSE frame from an event's raw JSON: only `type` and `state.revision` are read.
fn frame_of(event: &serde_json::value::RawValue) -> Option<SseFrame> {
    #[derive(serde::Deserialize)]
    struct Revision {
        revision: Option<f64>,
    }
    #[derive(serde::Deserialize)]
    struct Head<'a> {
        #[serde(rename = "type", borrow)]
        ty: std::borrow::Cow<'a, str>,
        state: Option<Revision>,
    }
    let json = event.get();
    let head: Head = serde_json::from_str(json).ok()?;
    let ty = head.ty.as_ref();
    if !matches!(ty, "stateChanged" | "selectedTranscriptChanged" | "terminalData" | "terminalExit" | "terminalError") {
        return None;
    }
    let mut text = String::with_capacity(json.len() + ty.len() + 16);
    text.push_str("event: ");
    text.push_str(ty);
    text.push_str("\ndata: ");
    text.push_str(json);
    text.push_str("\n\n");
    if text.len() > MAX_RESPONSE_BYTES {
        return None;
    }
    let is_state = ty == "stateChanged";
    let revision = if is_state { head.state.and_then(|s| s.revision) } else { None };
    Some(SseFrame { is_state, text: Arc::new(text), revision })
}

/// `{"type":..,"<key>":<raw>}` without re-encoding the raw part.
fn wrap_event(ty: &str, key: &str, raw: &str) -> Option<Box<serde_json::value::RawValue>> {
    serde_json::value::RawValue::from_string(format!("{{\"type\":\"{ty}\",\"{key}\":{raw}}}")).ok()
}

fn enqueue(s: &SseStream, f: SseFrame) {
    let mut st = lock(&s.state);
    if st.closed {
        return;
    }
    if f.is_state {
        if let (Some(prev), Some(rev)) = (st.highest_rev, f.revision) {
            if rev <= prev {
                return;
            }
        }
        st.highest_rev = f.revision.or(st.highest_rev);
    }
    // A queued snapshot is replaced by a newer one instead of piling up.
    let replace = f.is_state && st.queue.back().is_some_and(|t| t.is_state);
    let replaced = if replace { st.queue.back().map_or(0, |t| t.text.len()) } else { 0 };
    let next_bytes = st.queued_bytes - replaced + f.text.len();
    let next_count = st.queue.len() + usize::from(!replace);
    let elsewhere = st.in_flight + s.in_body.load(Ordering::SeqCst);
    if std::env::var_os("PEGASUS_REMOTE_TRACE").is_some() {
        crate::info!("sse enqueue: queued {} in_flight {} in_body {} next {}", st.queued_bytes, st.in_flight, s.in_body.load(Ordering::SeqCst), f.text.len());
    }
    if elsewhere + next_bytes > MAX_SSE_BUFFER_BYTES || next_count > MAX_SSE_QUEUED_FRAMES {
        drop(st);
        s.abort();
        return;
    }
    if replace {
        *st.queue.back_mut().expect("non-empty") = f;
    } else {
        st.queue.push_back(f);
    }
    st.queued_bytes = next_bytes;
    drop(st);
    s.wake.notify_one();
}

fn bootstrap(s: &SseStream, frames: Vec<SseFrame>) {
    let mut st = lock(&s.state);
    if st.closed {
        return;
    }
    let added: usize = frames.iter().map(|f| f.text.len()).sum();
    if s.pending_bytes(&st) + added > MAX_SSE_BUFFER_BYTES || st.queue.len() + frames.len() > MAX_SSE_QUEUED_FRAMES {
        drop(st);
        s.abort();
        return;
    } else {
        if let Some(rev) = frames.iter().find(|f| f.is_state).and_then(|f| f.revision) {
            st.highest_rev = Some(st.highest_rev.map_or(rev, |h| h.max(rev)));
        }
        for f in frames.into_iter().rev() {
            st.queue.push_front(f);
        }
        st.queued_bytes += added;
        st.initializing = false;
    }
    drop(st);
    s.wake.notify_one();
}

struct Encoder(Option<brotli::CompressorWriter<Vec<u8>>>);

impl Encoder {
    fn new(brotli_on: bool) -> Self {
        Encoder(brotli_on.then(|| {
            let params = brotli::enc::BrotliEncoderParams {
                quality: 4,
                lgwin: 24,
                mode: brotli::enc::backward_references::BrotliEncoderMode::BROTLI_MODE_TEXT,
                ..Default::default()
            };
            brotli::CompressorWriter::with_params(Vec::new(), 64 * 1024, &params)
        }))
    }
    fn encode(&mut self, text: &str) -> Bytes {
        use std::io::Write;
        match &mut self.0 {
            None => Bytes::copy_from_slice(text.as_bytes()),
            Some(w) => {
                let _ = w.write_all(text.as_bytes());
                let _ = w.flush();
                Bytes::from(std::mem::take(w.get_mut()))
            }
        }
    }
}

/// Resolves once the stream is marked closed (byte cap, provider stop).
async fn closed_signal(s: &SseStream) {
    loop {
        if lock(&s.state).closed {
            return;
        }
        s.wake.notified().await;
    }
}

async fn write_loop(remote: Arc<Remote>, s: Arc<SseStream>, tx: mpsc::Sender<(Bytes, usize)>, brotli_on: bool, ready: String) {
    let mut enc = Encoder::new(brotli_on);
    let done = AtomicBool::new(false);
    let in_body = s.in_body.clone();
    let send = |bytes: Bytes, raw: usize| {
        in_body.fetch_add(raw, Ordering::SeqCst);
        tx.send((bytes, raw))
    };
    if send(enc.encode(&ready), ready.len()).await.is_err() {
        done.store(true, Ordering::Relaxed);
    }
    while !done.load(Ordering::Relaxed) {
        // Next frame to write, skipping snapshots older than one already sent.
        let next = {
            let mut st = lock(&s.state);
            if st.closed {
                break;
            }
            let mut picked = None;
            if !st.initializing {
                while let Some(f) = st.queue.pop_front() {
                    st.queued_bytes -= f.text.len();
                    if f.is_state && matches!((st.last_sent_rev, f.revision), (Some(last), Some(r)) if r <= last) {
                        continue;
                    }
                    if f.is_state {
                        st.last_sent_rev = f.revision;
                    }
                    st.in_flight = f.text.len();
                    picked = Some(f);
                    break;
                }
            }
            picked
        };
        match next {
            Some(f) => {
                let bytes = enc.encode(&f.text);
                // A paused client blocks here; closing it (byte cap) or its disconnect ends the wait.
                // The frame counts as pending (in_flight) until the body channel has taken it.
                tokio::select! {
                    r = send(bytes, f.text.len()) => if r.is_err() { break },
                    _ = tx.closed() => break,
                    _ = closed_signal(&s) => break,
                }
                lock(&s.state).in_flight = 0;
            }
            None => {
                tokio::select! {
                    _ = s.wake.notified() => {}
                    // hyper dropped the body: the client went away; free its slot now.
                    _ = tx.closed() => break,
                    _ = tokio::time::sleep(HEARTBEAT) => {
                        let idle = { let st = lock(&s.state); !st.initializing && st.queue.is_empty() };
                        let beat = ": keep-alive\n\n";
                        if idle && send(enc.encode(beat), beat.len()).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
    }
    s.close();
    lock(&remote.streams).retain(|x| !Arc::ptr_eq(x, &s));
}

/// The SSE body: frames from the writer task; each one taken by hyper stops counting as pending.
struct Counted {
    rx: mpsc::Receiver<(Bytes, usize)>,
    in_body: Arc<std::sync::atomic::AtomicUsize>,
}

impl tokio_stream::Stream for Counted {
    type Item = Result<Frame<Bytes>, Infallible>;
    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx).map(|item| {
            item.map(|(bytes, raw)| {
                self.in_body.fetch_sub(raw, Ordering::SeqCst);
                Ok(Frame::data(bytes))
            })
        })
    }
}

// ---------- helpers ----------

enum Routed {
    Done(Response<Body>),
    /// Reply after reading and discarding the request body, so the client's upload is not reset.
    Drain(Incoming, Response<Body>),
}

/// Read and discard a request body (bounded in size and time) before an early error reply.
async fn drain(mut body: Incoming) {
    let mut seen = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while let Ok(Some(frame)) = tokio::time::timeout_at(deadline, body.frame()).await {
        match frame {
            Ok(f) => {
                seen += f.data_ref().map_or(0, |d| d.len());
                if seen > 2 * MAX_BODY_BYTES {
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

fn accepts_brotli(h: &HeaderMap) -> bool {
    header(h, "accept-encoding").is_some_and(|v| v.split(',').any(|p| p.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("br")))
}

fn authenticate(h: &HeaderMap, clients: &HashMap<String, String>) -> Option<String> {
    let raw = header(h, "authorization")?;
    let token = raw.strip_prefix("Bearer ")?;
    let ok = (32..=256).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b));
    let digest = crate::review::digest(token.as_bytes());
    // Compare against every client so timing does not reveal which digest matched.
    let mut found = None;
    for (d, id) in clients {
        let equal = d.len() == digest.len() && d.bytes().zip(digest.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
        if equal && ok {
            found = Some(id.clone());
        }
    }
    found
}

fn cors(h: &mut HeaderMap, origin: &str) {
    if origin.is_empty() {
        return;
    }
    if let Ok(v) = HeaderValue::from_str(origin) {
        h.insert("access-control-allow-origin", v);
        h.insert("vary", HeaderValue::from_static("Origin"));
    }
}

fn base_json(status: u16, body: Vec<u8>, origin: Option<&str>, br: bool) -> Response<Body> {
    let mut resp = Response::new(BoxBody::new(Full::new(Bytes::from(body))));
    *resp.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let h = resp.headers_mut();
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    h.insert("content-type", HeaderValue::from_static("application/json; charset=utf-8"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    if let Some(o) = origin {
        cors(h, o);
    }
    if br {
        h.insert("content-encoding", HeaderValue::from_static("br"));
        h.insert("vary", HeaderValue::from_static("Origin, Accept-Encoding"));
    }
    resp
}

fn error(status: u16, code: &str, message: &str, origin: Option<&str>) -> Response<Body> {
    // Every refused remote request is logged: a client that silently fails to connect is otherwise opaque.
    crate::info!("remote request refused: {status} {code}");
    let body = serde_json::to_vec(&serde_json::json!({ "version": 1, "error": { "code": code, "message": message } })).unwrap_or_default();
    base_json(status, body, origin, false)
}

async fn json_response(status: u16, body: Vec<u8>, brotli_ok: bool, origin: &str) -> Response<Body> {
    if body.len() > MAX_RESPONSE_BYTES {
        return error(413, "response_too_large", "The remote response exceeds its size limit.", Some(origin));
    }
    if !brotli_ok || body.len() < MIN_COMPRESSED_BYTES {
        return base_json(status, body, Some(origin), false);
    }
    let encoded = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        let params = brotli::enc::BrotliEncoderParams {
            quality: 5,
            mode: brotli::enc::backward_references::BrotliEncoderMode::BROTLI_MODE_TEXT,
            size_hint: body.len(),
            ..Default::default()
        };
        let _ = brotli::BrotliCompress(&mut &body[..], &mut out, &params);
        out
    })
    .await
    .unwrap_or_default();
    base_json(status, encoded, Some(origin), true)
}
