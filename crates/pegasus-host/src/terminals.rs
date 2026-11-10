//! Terminals owned by the host (ConPTY on Windows, openpty elsewhere), so they outlive window reloads
//! and a restarted client can adopt them. Output is decoded as UTF-8 (partial sequences carried across
//! reads), kept as a bounded replay, and pushed to subscribers in ~8 ms batches instead of per chunk.
//! On exit the console is closed so the reader drains to EOF, and only then is `TerminalExit` sent,
//! so the last output always arrives before the exit.
use pegasus_core::protocol::{
    ErrorCode, HostError, HostEvent, TerminalInfo, TerminalSnapshot, TerminalSpawnParams, TerminalStatus,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

/// Same budget as the renderer's replay (TERMINAL_REPLAY_BUFFER_LENGTH), in chars.
const REPLAY_CHARS: usize = 1_000_000;
const BATCH: Duration = Duration::from_millis(8);
const MAX_TERMINALS: usize = 64;
/// portable-pty creates ConPTY with PSEUDOCONSOLE_INHERIT_CURSOR, so the console opens with a cursor
/// position query and prints nothing until it is answered. A fresh terminal's cursor is at 1;1.
const STARTUP_DSR: &str = "\x1b[6n";
const STARTUP_DSR_REPLY: &[u8] = b"\x1b[1;1R";

struct State {
    info: TerminalInfo,
    replay: String,
    replay_chars: usize,
    truncated: bool,
}

/// The pty ends are `Option` so exit/kill can drop them: closing the console is what ends the reader.
struct Io {
    writer: Option<Box<dyn Write + Send>>,
    master: Option<Box<dyn MasterPty + Send>>,
}

struct Terminal {
    /// Connection that owns it; `None` = orphaned (its client left), killed after the grace period.
    owner: Mutex<Option<u64>>,
    state: Mutex<State>,
    io: Mutex<Io>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl Terminal {
    fn close_console(&self) {
        let mut io = lock(&self.io);
        io.writer = None;
        io.master = None;
    }
}

pub struct Terminals {
    map: Mutex<HashMap<String, Arc<Terminal>>>,
    running: Arc<AtomicU32>,
    events: broadcast::Sender<HostEvent>,
}

fn err(code: ErrorCode, msg: impl Into<String>) -> HostError {
    HostError::new(code, msg)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.clamp(4, 500), cols: cols.clamp(10, 1000), pixel_width: 0, pixel_height: 0 }
}

impl Terminals {
    pub fn new(events: broadcast::Sender<HostEvent>) -> Self {
        Terminals { map: Mutex::new(HashMap::new()), running: Arc::new(AtomicU32::new(0)), events }
    }

    /// Running terminals count as active work: the host will not exit under them.
    pub fn running(&self) -> u32 {
        self.running.load(Ordering::SeqCst)
    }

    fn get(&self, id: &str) -> Result<Arc<Terminal>, HostError> {
        lock(&self.map).get(id).cloned().ok_or_else(|| err(ErrorCode::NotFound, format!("no terminal {id}")))
    }

    pub fn spawn(&self, p: TerminalSpawnParams, owner: u64) -> Result<TerminalSnapshot, HostError> {
        if p.id.is_empty() || p.id.len() > 128 {
            return Err(err(ErrorCode::BadParams, "terminal id must be 1-128 chars"));
        }
        {
            let map = lock(&self.map);
            if map.contains_key(&p.id) {
                return Err(err(ErrorCode::AlreadyExists, format!("terminal {} exists", p.id)));
            }
            if map.len() >= MAX_TERMINALS {
                return Err(err(ErrorCode::BadParams, format!("at most {MAX_TERMINALS} terminals")));
            }
        }
        let size = pty_size(p.cols, p.rows);
        let spawn_err = |e: String| err(ErrorCode::SpawnFailed, format!("{}: {e}", p.shell));
        let pair = native_pty_system().openpty(size).map_err(|e| spawn_err(e.to_string()))?;
        let mut cmd = CommandBuilder::new(&p.shell);
        cmd.args(&p.args);
        cmd.cwd(&p.cwd);
        cmd.env_clear();
        for (k, v) in &p.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| spawn_err(e.to_string()))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| spawn_err(e.to_string()))?;
        let writer = pair.master.take_writer().map_err(|e| spawn_err(e.to_string()))?;
        let info = TerminalInfo {
            id: p.id.clone(),
            pid: child.process_id(),
            shell: p.shell.clone(),
            cwd: p.cwd.clone(),
            tag: p.tag,
            status: TerminalStatus::Running,
            exit_code: None,
            signal: None,
            cols: size.cols,
            rows: size.rows,
        };
        let term = Arc::new(Terminal {
            owner: Mutex::new(Some(owner)),
            state: Mutex::new(State { info, replay: String::new(), replay_chars: 0, truncated: false }),
            io: Mutex::new(Io { writer: Some(writer), master: Some(pair.master) }),
            killer: Mutex::new(child.clone_killer()),
        });
        lock(&self.map).insert(p.id.clone(), term.clone());
        self.running.fetch_add(1, Ordering::SeqCst);

        // Reader thread -> batcher task -> TerminalData events; `drained` fires after the last batch.
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let (drained_tx, drained_rx) = std::sync::mpsc::channel::<()>();
        let replier = term.clone();
        std::thread::Builder::new()
            .name(format!("pty-read-{}", p.id))
            .spawn(move || read_loop(reader, tx, replier))
            .map_err(|e| err(ErrorCode::Internal, e.to_string()))?;
        tokio::spawn(batch_loop(p.id.clone(), term.clone(), rx, self.events.clone(), drained_tx));

        // Waiter thread: exit -> close console -> wait for the reader to drain -> TerminalExit.
        let (id, events, running, waited) = (p.id.clone(), self.events.clone(), self.running.clone(), term.clone());
        std::thread::Builder::new()
            .name(format!("pty-wait-{}", p.id))
            .spawn(move || {
                let status = child.wait();
                let (exit_code, signal) = match &status {
                    Ok(s) => (Some(s.exit_code()), s.signal().map(str::to_string)),
                    Err(e) => {
                        crate::warn!("terminal {id} wait failed: {e}");
                        (None, None)
                    }
                };
                {
                    let mut st = lock(&waited.state);
                    st.info.status = TerminalStatus::Exited;
                    st.info.exit_code = exit_code;
                    st.info.signal = signal.clone();
                }
                running.fetch_sub(1, Ordering::SeqCst);
                waited.close_console();
                if drained_rx.recv_timeout(Duration::from_secs(3)).is_err() {
                    crate::warn!("terminal {id}: output did not drain within 3 s of exit");
                }
                crate::info!("terminal {id} exited ({exit_code:?})");
                let _ = events.send(HostEvent::TerminalExit { id, exit_code, signal });
            })
            .map_err(|e| err(ErrorCode::Internal, e.to_string()))?;
        crate::info!("terminal {} spawned: {} in {}", p.id, p.shell, p.cwd);
        Ok(snapshot(&term))
    }

    /// Attaching takes ownership, which also cancels a pending orphan kill.
    pub fn attach(&self, id: &str, owner: u64) -> Result<TerminalSnapshot, HostError> {
        let term = self.get(id)?;
        *lock(&term.owner) = Some(owner);
        Ok(snapshot(&term))
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), HostError> {
        let term = self.get(id)?;
        let mut io = lock(&term.io);
        let w = io.writer.as_mut().ok_or_else(|| err(ErrorCode::BadParams, format!("terminal {id} has exited")))?;
        w.write_all(data.as_bytes()).and_then(|_| w.flush()).map_err(|e| err(ErrorCode::Io, e.to_string()))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), HostError> {
        let term = self.get(id)?;
        let size = pty_size(cols, rows);
        if let Some(m) = lock(&term.io).master.as_ref() {
            m.resize(size).map_err(|e| err(ErrorCode::Io, e.to_string()))?;
        }
        let mut st = lock(&term.state);
        st.info.cols = size.cols;
        st.info.rows = size.rows;
        Ok(())
    }

    /// Kill the process (if running), close its console and forget the terminal.
    pub fn kill(&self, id: &str) -> Result<(), HostError> {
        let term = lock(&self.map).remove(id).ok_or_else(|| err(ErrorCode::NotFound, format!("no terminal {id}")))?;
        if lock(&term.state).info.status == TerminalStatus::Running {
            if let Err(e) = lock(&term.killer).kill() {
                crate::warn!("terminal {id} kill: {e}");
            }
        }
        term.close_console();
        crate::info!("terminal {id} killed");
        Ok(())
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        let mut v: Vec<_> = lock(&self.map).values().map(|t| lock(&t.state).info.clone()).collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    /// A client left: its terminals become orphans and are killed unless someone attaches within `grace`.
    /// This keeps terminals across a window reload or a quick app restart, and never leaks them.
    pub fn release(self: &Arc<Self>, owner: u64, grace: Duration) {
        let orphaned: Vec<String> = lock(&self.map)
            .iter()
            .filter_map(|(id, t)| {
                let mut o = lock(&t.owner);
                (*o == Some(owner)).then(|| {
                    *o = None;
                    id.clone()
                })
            })
            .collect();
        for id in orphaned {
            crate::info!("terminal {id} orphaned; killed in {}s unless re-attached", grace.as_secs());
            let me = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(grace).await;
                let still = lock(&me.map).get(&id).is_some_and(|t| lock(&t.owner).is_none());
                if still {
                    crate::info!("terminal {id}: no client re-attached");
                    let _ = me.kill(&id);
                }
            });
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = lock(&self.map).keys().cloned().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
    }
}

fn snapshot(term: &Terminal) -> TerminalSnapshot {
    let st = lock(&term.state);
    TerminalSnapshot { info: st.info.clone(), replay: st.replay.clone(), truncated: st.truncated }
}

/// Blocking pty reads, decoded as UTF-8 with incomplete trailing sequences carried to the next read.
fn read_loop(mut reader: Box<dyn Read + Send>, tx: mpsc::UnboundedSender<String>, term: Arc<Terminal>) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut carry: Vec<u8> = Vec::new();
    let mut first = cfg!(windows);
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buf[..n]);
        let valid = match std::str::from_utf8(&carry) {
            Ok(_) => carry.len(),
            // error_len None = truncated sequence at the end: keep it for the next read.
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => carry.len(),
        };
        let mut text = String::from_utf8_lossy(&carry[..valid]).into_owned();
        carry.drain(..valid);
        if first && !text.is_empty() {
            first = false;
            if let Some(rest) = text.strip_prefix(STARTUP_DSR) {
                text = rest.to_string();
                if let Some(w) = lock(&term.io).writer.as_mut() {
                    let _ = w.write_all(STARTUP_DSR_REPLY).and_then(|_| w.flush());
                }
            }
        }
        if !text.is_empty() && tx.send(text).is_err() {
            break;
        }
    }
    if !carry.is_empty() {
        let _ = tx.send(String::from_utf8_lossy(&carry).into_owned());
    }
}

async fn batch_loop(
    id: String,
    term: Arc<Terminal>,
    mut rx: mpsc::UnboundedReceiver<String>,
    events: broadcast::Sender<HostEvent>,
    drained: std::sync::mpsc::Sender<()>,
) {
    while let Some(first) = rx.recv().await {
        let mut data = first;
        tokio::time::sleep(BATCH).await;
        while let Ok(more) = rx.try_recv() {
            data.push_str(&more);
        }
        append_replay(&mut lock(&term.state), &data);
        let _ = events.send(HostEvent::TerminalData { id: id.clone(), data });
    }
    let _ = drained.send(());
}

fn append_replay(st: &mut State, data: &str) {
    st.replay.push_str(data);
    st.replay_chars += data.chars().count();
    if st.replay_chars > REPLAY_CHARS {
        let drop_chars = st.replay_chars - REPLAY_CHARS;
        let cut = st.replay.char_indices().nth(drop_chars).map_or(st.replay.len(), |(i, _)| i);
        st.replay.drain(..cut);
        st.replay_chars = REPLAY_CHARS;
        st.truncated = true;
    }
}
