//! Spawns the real binary on a private endpoint and talks the wire protocol to it.
use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

fn endpoint(tag: &str) -> String {
    let id = format!("{tag}-{}", std::process::id());
    if cfg!(windows) { format!(r"\\.\pipe\pegasus-host-test-{id}") } else { std::env::temp_dir().join(format!("ph-{id}.sock")).to_string_lossy().into() }
}

fn spawn(ep: &str, root: &std::path::Path, idle: u64) -> Child {
    Command::new(env!("CARGO_BIN_EXE_pegasus-host"))
        .args(["--endpoint", ep, "--sessions-root"]).arg(root)
        .args(["--idle-exit-secs", &idle.to_string()])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().unwrap()
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

async fn connect(ep: &str) -> Box<dyn Io> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        #[cfg(windows)]
        let r = tokio::net::windows::named_pipe::ClientOptions::new().open(ep).map(|c| Box::new(c) as Box<dyn Io>);
        #[cfg(unix)]
        let r = tokio::net::UnixStream::connect(ep).await.map(|c| Box::new(c) as Box<dyn Io>);
        match r {
            Ok(c) => return c,
            Err(e) if Instant::now() > deadline => panic!("connect {ep}: {e}"),
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

async fn send(c: &mut Box<dyn Io>, v: Value) {
    let b = v.to_string().into_bytes();
    c.write_all(&(b.len() as u32).to_be_bytes()).await.unwrap();
    c.write_all(&b).await.unwrap();
}

async fn recv(c: &mut Box<dyn Io>) -> Value {
    let mut len = [0u8; 4];
    c.read_exact(&mut len).await.unwrap();
    let mut b = vec![0u8; u32::from_be_bytes(len) as usize];
    c.read_exact(&mut b).await.unwrap();
    serde_json::from_slice(&b).unwrap()
}

async fn call(c: &mut Box<dyn Io>, id: u64, method: &str, params: Value) -> Value {
    send(c, json!({"v":2,"id":id,"method":method,"params":params})).await;
    loop {
        let v = recv(c).await;
        if v["id"] == id { return v; }
    }
}

fn wait_exit(child: &mut Child, secs: u64) -> Option<i32> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if let Some(s) = child.try_wait().unwrap() { return s.code(); }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_handshake_errors_and_shutdown() {
    let root = std::env::temp_dir().join(format!("pegasus-host-root-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("life");
    let mut host = spawn(&ep, &root, 600);
    let mut c = connect(&ep).await;

    let hello = call(&mut c, 1, "hello", json!({"client":"test","appVersion":"0.0.0"})).await;
    assert_eq!(hello["result"]["protocol"], 2, "{hello}");
    assert_eq!(hello["result"]["pid"], host.id());

    // A second host on the same endpoint refuses to start (exit 3) and the first keeps serving.
    let mut second = spawn(&ep, &root, 600);
    assert_eq!(wait_exit(&mut second, 10), Some(3));
    let st = call(&mut c, 2, "status", json!({})).await;
    assert_eq!(st["result"]["clients"], 1, "{st}");

    // Typed errors.
    assert_eq!(call(&mut c, 3, "nope", json!({})).await["error"]["code"], "unknown_method");
    assert_eq!(call(&mut c, 4, "status", json!({"x":1})).await["error"]["code"], "bad_params");
    send(&mut c, json!({"v":1,"id":5,"method":"status"})).await;
    assert_eq!(recv(&mut c).await["error"]["code"], "unsupported_protocol");
    assert_eq!(call(&mut c, 6, "index.list", json!({})).await["result"]["sessions"], json!([]));

    // Shutdown: reply, then a shuttingDown event, then the process exits 0.
    let sd = call(&mut c, 7, "shutdown", json!({"reason":"test"})).await;
    assert_eq!(sd["result"]["accepted"], true);
    let ev = recv(&mut c).await;
    assert_eq!(ev["event"], "shuttingDown", "{ev}");
    assert_eq!(wait_exit(&mut host, 10), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn exits_when_idle_without_clients() {
    let root = std::env::temp_dir().join(format!("pegasus-host-idle-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("idle");
    let mut host = spawn(&ep, &root, 1);
    {
        let mut c = connect(&ep).await;
        call(&mut c, 1, "hello", json!({"client":"test","appVersion":"0.0.0"})).await;
        // While connected it stays up past the idle window.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(host.try_wait().unwrap().is_none(), "host exited while a client was attached");
    }
    assert_eq!(wait_exit(&mut host, 15), Some(0));
}
