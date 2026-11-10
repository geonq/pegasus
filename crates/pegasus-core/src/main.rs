//! pegasus-sidecar --sessions-root <dir> [--cache <file>]: serves pegasus-core over stdin/stdout frames.
//! stdout carries frames only; diagnostics go to stderr.
use pegasus_core::rpc::Server;
use std::path::PathBuf;

fn main() {
    let (mut root, mut cache) = (None, None);
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match (a.as_str(), args.next()) {
            ("--sessions-root", Some(v)) => root = Some(PathBuf::from(v)),
            ("--cache", Some(v)) => cache = Some(PathBuf::from(v)),
            _ => fail("usage: pegasus-sidecar --sessions-root <dir> [--cache <file>]"),
        }
    }
    let Some(root) = root else { fail("--sessions-root is required") };
    let mut server = Server::new(&root, cache).unwrap_or_else(|e| fail(&format!("sessions root {}: {e}", root.display())));
    if let Err(e) = server.serve(std::io::stdin().lock(), std::io::stdout().lock()) {
        fail(&format!("transport: {e}"));
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("pegasus-sidecar: {msg}");
    std::process::exit(2)
}
