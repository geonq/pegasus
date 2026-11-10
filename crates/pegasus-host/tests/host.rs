//! Spawns the real binary on a private endpoint and talks the wire protocol to it.
use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

fn endpoint(tag: &str) -> String {
    let id = format!("{tag}-{}", std::process::id());
    if cfg!(windows) { format!(r"\\.\pipe\pegasus-host-test-{id}") } else { std::env::temp_dir().join(format!("ph-{id}.sock")).to_string_lossy().into() }
}

/// Kills the host if a test fails midway, so no orphan keeps the test's pipes open.
struct Proc(Child);
impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}
impl std::ops::Deref for Proc {
    type Target = Child;
    fn deref(&self) -> &Child { &self.0 }
}
impl std::ops::DerefMut for Proc {
    fn deref_mut(&mut self) -> &mut Child { &mut self.0 }
}

fn spawn(ep: &str, root: &std::path::Path, idle: u64) -> Proc {
    Proc(Command::new(env!("CARGO_BIN_EXE_pegasus-host"))
        .args(["--endpoint", ep, "--sessions-root"]).arg(root)
        .args(["--idle-exit-secs", &idle.to_string()])
        .arg("--log-dir").arg(root.join("logs"))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().unwrap())
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
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let v = tokio::time::timeout(left, recv(c)).await.unwrap_or_else(|_| panic!("{method} #{id}: no reply in 20 s"));
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

fn shell() -> (String, Vec<String>) {
    if cfg!(windows) { ("cmd.exe".into(), vec!["/Q".into(), "/K".into()]) } else { ("/bin/sh".into(), vec![]) }
}

fn env_now() -> serde_json::Map<String, Value> {
    std::env::vars().map(|(k, v)| (k, Value::String(v))).collect()
}

/// Reads frames until `pred` matches one, collecting terminal output on the way.
async fn until(c: &mut Box<dyn Io>, out: &mut String, secs: u64, pred: impl Fn(&Value, &str) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let v = tokio::time::timeout(left, recv(c)).await.unwrap_or_else(|_| panic!("timed out; output so far: {out:?}"));
        if std::env::var("HOST_TEST_TRACE").is_ok() { eprintln!("frame {v}"); }
        if v["event"] == "terminalData" { out.push_str(v["data"]["data"].as_str().unwrap_or("")); }
        if pred(&v, out) { return v; }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn terminals_run_replay_survive_reconnect_and_block_soft_shutdown() {
    let root = std::env::temp_dir().join(format!("pegasus-host-term-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("term");
    let mut host = spawn(&ep, &root, 600);
    let mut c = connect(&ep).await;
    let (sh, args) = shell();
    let r = call(&mut c, 1, "terminal.spawn", json!({
        "id": "t1", "shell": sh, "args": args, "cwd": root.to_string_lossy(), "env": env_now(),
        "cols": 100, "rows": 30, "tag": "{\"workspace\":\"w\"}"
    })).await;
    assert_eq!(r["result"]["info"]["status"], "running", "{r}");
    assert!(r["result"]["info"]["pid"].as_u64().is_some());

    send(&mut c, json!({"v":2,"id":2,"method":"terminal.write","params":{"id":"t1","data":"echo pegasus-marker-1\r"}})).await;
    let mut out = String::new();
    until(&mut c, &mut out, 15, |_, o| o.matches("pegasus-marker-1").count() >= 2).await;

    // Running terminal = active work: soft shutdown refused, host stays.
    let sd = call(&mut c, 3, "shutdown", json!({"reason":"soft"})).await;
    assert_eq!(sd["result"]["accepted"], false, "{sd}");
    assert_eq!(sd["result"]["activeWork"], 1);

    // The client goes away; the terminal keeps running. A new client adopts it with replay.
    drop(c);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut c2 = connect(&ep).await;
    let list = call(&mut c2, 1, "terminal.list", json!({})).await;
    assert_eq!(list["result"]["terminals"][0]["tag"], "{\"workspace\":\"w\"}");
    let snap = call(&mut c2, 2, "terminal.attach", json!({"id":"t1"})).await;
    assert!(snap["result"]["replay"].as_str().unwrap().contains("pegasus-marker-1"));
    send(&mut c2, json!({"v":2,"id":3,"method":"terminal.write","params":{"id":"t1","data":"echo pegasus-marker-2\r"}})).await;
    let mut out2 = String::new();
    until(&mut c2, &mut out2, 15, |_, o| o.matches("pegasus-marker-2").count() >= 2).await;

    // Typed errors.
    let dup = call(&mut c2, 4, "terminal.spawn", json!({"id":"t1","shell":"x","cwd":".","env":{},"cols":80,"rows":24,"tag":""})).await;
    assert_eq!(dup["error"]["code"], "already_exists");
    let bad = call(&mut c2, 5, "terminal.spawn", json!({"id":"t2","shell":"definitely-not-a-shell-xyz","cwd":root.to_string_lossy(),"env":{},"cols":80,"rows":24,"tag":""})).await;
    assert_eq!(bad["error"]["code"], "spawn_failed", "{bad}");
    assert_eq!(call(&mut c2, 6, "terminal.write", json!({"id":"nope","data":"x"})).await["error"]["code"], "not_found");

    // Exit is reported, then kill forgets it.
    send(&mut c2, json!({"v":2,"id":7,"method":"terminal.write","params":{"id":"t1","data":"exit 7\r"}})).await;
    let ex = until(&mut c2, &mut out2, 15, |v, _| v["event"] == "terminalExit").await;
    assert_eq!(ex["data"]["exitCode"], 7, "{ex}");
    assert_eq!(call(&mut c2, 8, "terminal.kill", json!({"id":"t1"})).await["result"], json!({}));
    assert_eq!(call(&mut c2, 9, "terminal.list", json!({})).await["result"]["terminals"], json!([]));

    assert_eq!(call(&mut c2, 10, "shutdown", json!({"reason":"done"})).await["result"]["accepted"], true);
    assert_eq!(wait_exit(&mut host, 10), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn detached_host_holds_no_launcher_pipes_and_reaps_orphaned_terminals() {
    let root = std::env::temp_dir().join(format!("pegasus-host-detach-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let ep = endpoint("detach");
    // The launcher's stdout is a pipe we read to EOF: it must close as soon as the launcher exits,
    // even though the host it started keeps running.
    let started = Instant::now();
    let out = Command::new(env!("CARGO_BIN_EXE_pegasus-host"))
        .args(["--detach", "--endpoint", &ep, "--sessions-root"]).arg(&root)
        .args(["--idle-exit-secs", "2", "--orphan-grace-secs", "1"])
        .arg("--log-dir").arg(root.join("logs"))
        .stdout(Stdio::piped()).stderr(Stdio::piped())
        .output().unwrap();
    assert!(out.status.success(), "{out:?}");
    assert!(started.elapsed() < Duration::from_secs(5), "launcher pipes stayed open");

    let mut c = connect(&ep).await;
    let (sh, args) = shell();
    let r = call(&mut c, 1, "terminal.spawn", json!({
        "id": "orphan", "shell": sh, "args": args, "cwd": root.to_string_lossy(), "env": env_now(),
        "cols": 80, "rows": 24, "tag": ""
    })).await;
    let pid = r["result"]["info"]["pid"].as_u64().unwrap();
    let host_pid = call(&mut c, 2, "status", json!({})).await["result"]["pid"].as_u64().unwrap() as u32;
    drop(c);
    // No client re-attaches: after the 1 s grace the terminal is killed, then the idle host exits.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut host_gone = false;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
        // Poll the process, not the endpoint: a probe connection would count as a client.
        if !process_alive(host_pid) { host_gone = true; break; }
    }
    let log = std::fs::read_to_string(root.join("logs").join("pegasus-host.log")).unwrap_or_default();
    assert!(host_gone, "host still running; log:\n{log}");
    assert!(log.contains("terminal orphan: no client re-attached"), "{log}");
    assert!(!process_alive(pid as u32), "shell {pid} survived");
}

fn process_alive(pid: u32) -> bool {
    if cfg!(windows) {
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    } else {
        Command::new("kill").args(["-0", &pid.to_string()]).status().is_ok_and(|s| s.success())
    }
}
