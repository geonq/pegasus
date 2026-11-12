//! Long-lived Node runtime worker supervision. The host owns this child so Electron can quit
//! without interrupting an agent run. The worker speaks the same length-prefixed JSON framing as
//! the host connection; protocol-specific requests are added by the runtime slice.
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;
use tokio::process::{Child, Command};

pub struct RuntimeWorker {
    child: Child,
}

impl RuntimeWorker {
    /// Start supervision when configured. Keeping this opt-in leaves existing development and
    /// test profiles unchanged until they provide the packaged worker entry point.
    pub fn start(
        log_dir: Option<&Path>,
        mut exiting: watch::Receiver<bool>,
    ) -> Option<tokio::task::JoinHandle<()>> {
        let executable = std::env::var_os("PEGASUS_RUNTIME_WORKER")?;
        let script = std::env::var_os("PEGASUS_RUNTIME_WORKER_SCRIPT");
        let log_path = log_dir.map(|dir| dir.join("runtime-worker.log"));
        Some(tokio::spawn(async move {
            let mut worker = Self::spawn(&executable, script.as_deref(), log_path.as_deref()).await;
            loop {
                match worker {
                    Ok(mut running) => {
                        crate::info!("runtime worker started pid {:?}", running.child.id());
                        tokio::select! {
                            result = running.child.wait() => match result {
                                Ok(status) => crate::warn!("runtime worker exited ({status}); restarting"),
                                Err(error) => crate::warn!("runtime worker wait failed ({error}); restarting"),
                            },
                            _ = exiting.changed() => {
                                if *exiting.borrow() {
                                    let _ = running.child.kill().await;
                                    return;
                                }
                            },
                        }
                    }
                    Err(error) => crate::warn!("runtime worker spawn failed ({error}); retrying"),
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                    _ = exiting.changed() => {
                        if *exiting.borrow() { return; }
                    },
                }
                worker = Self::spawn(&executable, script.as_deref(), log_path.as_deref()).await;
            }
        }))
    }

    async fn spawn(
        executable: &std::ffi::OsStr,
        script: Option<&std::ffi::OsStr>,
        log_path: Option<&Path>,
    ) -> std::io::Result<Self> {
        let mut command = Command::new(executable);
        if let Some(script) = script {
            command.arg(script);
        }
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(path) = log_path {
            if let Some(parent) = path.parent() { tokio::fs::create_dir_all(parent).await?; }
            let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
            let err = file.try_clone()?;
            command.stdout(Stdio::from(file)).stderr(Stdio::from(err));
        }
        let mut child = command.spawn()?;
        // A supervisor-owned child must not inherit a pipe that can keep the host alive after an
        // orderly shutdown. The worker receives SIGTERM/Terminate through process ownership later.
        if let Some(stdin) = child.stdin.as_mut() {
            let hello = br#"{"v":1,"type":"hello","role":"pegasus-runtime"}
"#;
            stdin.write_all(&(hello.len() as u32).to_be_bytes()).await?;
            stdin.write_all(hello).await?;
            stdin.flush().await?;
        }
        Ok(Self { child })
    }
}
