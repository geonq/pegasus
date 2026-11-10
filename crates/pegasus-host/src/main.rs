#![cfg_attr(windows, windows_subsystem = "windows")]
//! pegasus-host --endpoint <pipe-or-socket> --sessions-root <dir> [--cache <file>] [--log-dir <dir>]
//!              [--idle-exit-secs N]
//!
//! One host per profile. It outlives the Electron window: clients attach over a named pipe (Windows)
//! or a unix socket, and the host exits only on an accepted `shutdown` or after being idle (no
//! clients, no active work) for `--idle-exit-secs` (default 600). A second host on the same endpoint
//! exits with code 3 so racing launchers are harmless.
mod host;
mod log;

use host::{event_frame, Host};
use pegasus_core::protocol::MAX_REQUEST;
use pegasus_core::rpc::Server as Sessions;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

struct Args {
    endpoint: String,
    sessions_root: PathBuf,
    cache: Option<PathBuf>,
    log_dir: Option<PathBuf>,
    idle: Duration,
}

fn args() -> Args {
    let (mut endpoint, mut root, mut cache, mut log_dir, mut idle) = (None, None, None, None, 600u64);
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match (a.as_str(), it.next()) {
            ("--endpoint", Some(v)) => endpoint = Some(v),
            ("--sessions-root", Some(v)) => root = Some(PathBuf::from(v)),
            ("--cache", Some(v)) => cache = Some(PathBuf::from(v)),
            ("--log-dir", Some(v)) => log_dir = Some(PathBuf::from(v)),
            ("--idle-exit-secs", Some(v)) => idle = v.parse().unwrap_or_else(|_| fail(2, "--idle-exit-secs must be a number")),
            _ => fail(2, "usage: pegasus-host --endpoint <name> --sessions-root <dir> [--cache <file>] [--log-dir <dir>] [--idle-exit-secs N]"),
        }
    }
    Args {
        endpoint: endpoint.unwrap_or_else(|| fail(2, "--endpoint is required")),
        sessions_root: root.unwrap_or_else(|| fail(2, "--sessions-root is required")),
        cache,
        log_dir,
        idle: Duration::from_secs(idle),
    }
}

fn fail(code: i32, msg: &str) -> ! {
    log::write("ERROR", msg);
    std::process::exit(code)
}

#[tokio::main]
async fn main() {
    let a = args();
    log::init(a.log_dir.clone());
    std::panic::set_hook(Box::new(|info| log::write("PANIC", &info.to_string())));
    // The sessions root may not exist yet on a fresh profile.
    let _ = std::fs::create_dir_all(&a.sessions_root);
    let sessions = Sessions::new(&a.sessions_root, a.cache.clone())
        .unwrap_or_else(|e| fail(2, &format!("sessions root {}: {e}", a.sessions_root.display())));
    let host = Host::new(sessions);
    info!("pegasus-host {} pid {} on {}", host::HOST_VERSION, std::process::id(), a.endpoint);

    let mut exiting = host.exiting.subscribe();
    let idle_host = host.clone();
    let idle = a.idle;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5).min(idle)).await;
            if idle_host.idle_for(idle) {
                idle_host.begin_exit(&format!("idle {}s with no clients", idle.as_secs()));
                return;
            }
        }
    });

    tokio::select! {
        r = transport::serve(&a.endpoint, host.clone()) => {
            if let Err(e) = r { fail(if e.kind() == std::io::ErrorKind::AddrInUse { 3 } else { 1 }, &format!("endpoint {}: {e}", a.endpoint)) }
        }
        _ = exiting.wait_for(|x| *x) => {}
    }
    // Let ShuttingDown events flush to clients.
    tokio::time::sleep(Duration::from_millis(100)).await;
    transport::cleanup(&a.endpoint);
    info!("exited");
}

/// Per-connection loop: frames in, dispatched concurrently, responses and events out through one writer.
async fn connection<S: AsyncRead + AsyncWrite + Send + 'static>(stream: S, host: Arc<Host>) {
    let n = host.client_connected();
    info!("client connected ({n} total)");
    let (mut r, mut w) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(256);
    let mut events = host.events.subscribe();
    let ev_tx = tx.clone();
    let ev_task = tokio::spawn(async move {
        while let Ok(e) = events.recv().await {
            if ev_tx.send(event_frame(&e)).await.is_err() {
                return;
            }
        }
    });
    let writer = tokio::spawn(async move {
        while let Some(body) = rx.recv().await {
            let len = (body.len() as u32).to_be_bytes();
            if w.write_all(&len).await.is_err() || w.write_all(&body).await.is_err() || w.flush().await.is_err() {
                return;
            }
        }
    });
    let client = Arc::new(tokio::sync::Mutex::new(String::from("unnamed")));
    loop {
        let mut len = [0u8; 4];
        if r.read_exact(&mut len).await.is_err() {
            break;
        }
        let n = u32::from_be_bytes(len) as usize;
        if n > MAX_REQUEST {
            warn!("{} sent a {n}-byte frame; closing", client.lock().await);
            break;
        }
        let mut body = vec![0u8; n];
        if r.read_exact(&mut body).await.is_err() {
            break;
        }
        let (host, tx, client) = (host.clone(), tx.clone(), client.clone());
        tokio::spawn(async move {
            // hello renames the client; other calls only read the name.
            let mut name = client.lock().await.clone();
            let out = host.dispatch(&body, &mut name).await;
            *client.lock().await = name;
            let _ = tx.send(out).await;
        });
    }
    ev_task.abort();
    drop(tx);
    let _ = writer.await;
    let left = host.client_left();
    info!("{} disconnected ({left} left)", client.lock().await);
}

#[cfg(windows)]
mod transport {
    use super::*;
    use tokio::net::windows::named_pipe::ServerOptions;

    pub async fn serve(endpoint: &str, host: Arc<Host>) -> std::io::Result<()> {
        // first_pipe_instance fails when another host already owns the name.
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(endpoint)
            .map_err(|e| if e.raw_os_error() == Some(5) { std::io::Error::new(std::io::ErrorKind::AddrInUse, "another host owns this endpoint") } else { e })?;
        loop {
            server.connect().await?;
            let connected = server;
            server = ServerOptions::new().reject_remote_clients(true).create(endpoint)?;
            tokio::spawn(connection(connected, host.clone()));
        }
    }

    pub fn cleanup(_endpoint: &str) {}
}

#[cfg(unix)]
mod transport {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::{UnixListener, UnixStream};

    pub async fn serve(endpoint: &str, host: Arc<Host>) -> std::io::Result<()> {
        if UnixStream::connect(endpoint).await.is_ok() {
            return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "another host owns this endpoint"));
        }
        let _ = std::fs::remove_file(endpoint); // stale socket from a crashed host
        let listener = UnixListener::bind(endpoint)?;
        std::fs::set_permissions(endpoint, std::fs::Permissions::from_mode(0o600))?;
        loop {
            let (stream, _) = listener.accept().await?;
            tokio::spawn(connection(stream, host.clone()));
        }
    }

    pub fn cleanup(endpoint: &str) {
        let _ = std::fs::remove_file(endpoint);
    }
}
