//! pegasus-events: one timeline from every Pegasus event log.
//!
//!   pegasus-events [--dir <logs dir>]... [--errors] [--session <id>] [--kind <prefix>]
//!                  [--since <10m|2h|1d>] [--last N] [--summary] [--json]
//!
//! Reads `events.ndjson` (Electron main + renderer, `<userData>/logs`) and `host-events.ndjson`
//! (the Rust host, `<agent dir>/logs`), each with its `.1` rotation, merges them by time and prints
//! one line per event. `--errors` keeps errors and warnings plus the context lines logged with
//! them (the IPC calls and session events just before an error). A gap in a process's line numbers
//! is reported, so lost lines are visible instead of silently missing.
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const FILES: &[&str] = &["events.ndjson.1", "events.ndjson", "host-events.ndjson.1", "host-events.ndjson"];
const ENVELOPE: &[&str] = &["t", "n", "p", "src", "k", "l", "s", "r", "ctx"];

#[derive(Default)]
struct Args {
    dirs: Vec<PathBuf>,
    errors: bool,
    session: Option<String>,
    kind: Option<String>,
    since_ms: Option<u64>,
    last: Option<usize>,
    summary: bool,
    json: bool,
}

fn usage() -> ! {
    eprintln!("usage: pegasus-events [--dir <logs dir>]... [--errors] [--session <id>] [--kind <prefix>] [--since 10m|2h|1d] [--last N] [--summary] [--json]");
    std::process::exit(2)
}

fn parse_args() -> Args {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dir" => a.dirs.push(PathBuf::from(it.next().unwrap_or_else(|| usage()))),
            "--errors" | "-e" => a.errors = true,
            "--session" | "-s" => a.session = Some(it.next().unwrap_or_else(|| usage())),
            "--kind" | "-k" => a.kind = Some(it.next().unwrap_or_else(|| usage())),
            "--since" => a.since_ms = Some(duration_ms(&it.next().unwrap_or_else(|| usage())).unwrap_or_else(|| usage())),
            "--last" | "-n" => a.last = Some(it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage())),
            "--summary" => a.summary = true,
            "--json" => a.json = true,
            _ => usage(),
        }
    }
    if a.dirs.is_empty() {
        a.dirs = default_dirs();
    }
    a
}

/// `90s`, `10m`, `2h`, `1d` -> milliseconds.
fn duration_ms(text: &str) -> Option<u64> {
    let (num, unit) = text.split_at(text.find(|c: char| !c.is_ascii_digit())?);
    let n: u64 = num.parse().ok()?;
    let scale = match unit {
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    };
    Some(n * scale)
}

/// The app's and the host's log folders for the profile this shell points at.
fn default_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let env = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(user_data) = env("PI_APP_USER_DATA_DIR") {
        dirs.push(user_data.join("logs"));
    } else if let Some(appdata) = env("APPDATA") {
        dirs.push(appdata.join("Pegasus").join("logs"));
    } else if let Some(home) = env("HOME") {
        dirs.push(home.join("Library/Application Support/Pegasus/logs"));
        dirs.push(home.join(".config/Pegasus/logs"));
    }
    if let Some(agent) = env("PI_CODING_AGENT_DIR") {
        dirs.push(agent.join("logs"));
    } else if let Some(home) = env("USERPROFILE").or_else(|| env("HOME")) {
        dirs.push(home.join(".pi").join("agent").join("logs"));
    }
    dirs
}

struct Event {
    t: u64,
    order: usize,
    v: Map<String, Value>,
}

fn read_events(dirs: &[PathBuf]) -> (Vec<Event>, Vec<String>) {
    let mut events = Vec::new();
    let mut notes = Vec::new();
    for dir in dirs {
        for name in FILES {
            let path = dir.join(name);
            let Ok(file) = std::fs::File::open(&path) else { continue };
            let mut bad = 0usize;
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else { break };
                match serde_json::from_str::<Value>(&line) {
                    Ok(Value::Object(v)) => {
                        let t = v.get("t").and_then(Value::as_u64).unwrap_or(0);
                        events.push(Event { t, order: events.len(), v });
                    }
                    _ if line.trim().is_empty() => {}
                    // A torn last line from a crash is expected; anything more is worth knowing.
                    _ => bad += 1,
                }
            }
            if bad > 0 {
                notes.push(format!("{}: {bad} unreadable line(s)", path.display()));
            }
        }
    }
    events.sort_by_key(|e| (e.t, e.order));
    (events, notes)
}

/// Gaps in each process's line numbers: lines that were logged but never reached the file.
fn gaps(events: &[Event]) -> Vec<String> {
    let mut last: HashMap<(String, u64), u64> = HashMap::new();
    let mut out = Vec::new();
    for e in events {
        let (Some(p), Some(n)) = (e.v.get("p").and_then(Value::as_u64), e.v.get("n").and_then(Value::as_u64)) else { continue };
        let src = str_of(&e.v, "src").to_string();
        let key = (src.clone(), p);
        // Context lines are replayed out of order (they are written after the error that flushed them).
        if e.v.contains_key("ctx") {
            continue;
        }
        if let Some(prev) = last.get(&key) {
            if n > prev + 1 && n > *prev {
                out.push(format!("{} {src} pid {p}: lines {}..{} missing", clock(e.t), prev + 1, n - 1));
            }
        }
        last.insert(key, n.max(*last.get(&(src, p)).unwrap_or(&0)));
    }
    out
}

fn str_of<'a>(v: &'a Map<String, Value>, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `2026-11-12 09:41:07.123Z` from epoch ms, without a date library.
fn clock(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms % 1000)
}

fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn render(e: &Event) -> String {
    let v = &e.v;
    let level = match str_of(v, "l") {
        "e" => "ERR ",
        "w" => "WARN",
        _ if v.contains_key("ctx") => " ·  ",
        _ => "    ",
    };
    let mut line = format!("{} {level} {:<8} {:<22}", clock(e.t), str_of(v, "src"), str_of(v, "k"));
    if let Some(s) = v.get("s").and_then(Value::as_str) {
        line.push_str(&format!(" s={}", short(s)));
    }
    if let Some(r) = v.get("r").and_then(Value::as_str) {
        line.push_str(&format!(" r={}", short(r)));
    }
    let mut rest: Vec<(&String, &Value)> = v.iter().filter(|(k, _)| !ENVELOPE.contains(&k.as_str())).collect();
    // Messages and stacks last, so the short fields line up.
    rest.sort_by_key(|(k, _)| matches!(k.as_str(), "msg" | "stack"));
    for (k, val) in rest {
        let text = match val {
            Value::String(s) => {
                let flat = s.replace('\n', " ⏎ ");
                if flat.contains(' ') { format!("{flat:?}") } else { flat }
            }
            other => other.to_string(),
        };
        line.push_str(&format!(" {k}={text}"));
    }
    line
}

fn main() {
    let a = parse_args();
    let (mut events, notes) = read_events(&a.dirs);
    let missing = gaps(&events);
    if let Some(since) = a.since_ms {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        events.retain(|e| e.t + since >= now);
    }
    if let Some(session) = &a.session {
        events.retain(|e| str_of(&e.v, "s").starts_with(session.as_str()));
    }
    if let Some(kind) = &a.kind {
        events.retain(|e| str_of(&e.v, "k").starts_with(kind.as_str()));
    }
    if a.errors {
        events.retain(|e| matches!(str_of(&e.v, "l"), "e" | "w") || e.v.contains_key("ctx"));
    }
    if let Some(last) = a.last {
        let skip = events.len().saturating_sub(last);
        events.drain(..skip);
    }

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if a.summary {
        let mut kinds: BTreeMap<(String, String), (usize, usize, usize)> = BTreeMap::new();
        for e in &events {
            let entry = kinds.entry((str_of(&e.v, "src").into(), str_of(&e.v, "k").into())).or_default();
            entry.0 += 1;
            match str_of(&e.v, "l") {
                "e" => entry.1 += 1,
                "w" => entry.2 += 1,
                _ => {}
            }
        }
        let _ = writeln!(out, "{:<9} {:<26} {:>7} {:>6} {:>6}", "source", "kind", "events", "errors", "warn");
        for ((src, kind), (n, errs, warns)) in kinds {
            let _ = writeln!(out, "{src:<9} {kind:<26} {n:>7} {errs:>6} {warns:>6}");
        }
        if let (Some(first), Some(last)) = (events.first(), events.last()) {
            let _ = writeln!(out, "{} events from {} to {}", events.len(), clock(first.t), clock(last.t));
        }
    } else {
        for e in &events {
            let _ = if a.json {
                writeln!(out, "{}", Value::Object(e.v.clone()))
            } else {
                writeln!(out, "{}", render(e))
            };
        }
    }
    for note in notes.iter().chain(missing.iter()) {
        eprintln!("note: {note}");
    }
    if events.is_empty() && !a.summary {
        let looked: Vec<String> = a.dirs.iter().map(|d| d.display().to_string()).collect();
        eprintln!("no events (looked in {})", looked.join(", "));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_formats_utc() {
        assert_eq!(clock(0), "1970-01-01 00:00:00.000Z");
        assert_eq!(clock(1_762_941_667_123), "2025-11-12 10:01:07.123Z");
    }

    #[test]
    fn durations() {
        assert_eq!(duration_ms("90s"), Some(90_000));
        assert_eq!(duration_ms("2h"), Some(7_200_000));
        assert_eq!(duration_ms("x"), None);
    }

    #[test]
    fn merges_sources_by_time_and_reports_gaps() {
        let dir = std::env::temp_dir().join(format!("pegasus-events-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(
            dir.join("events.ndjson"),
            "{\"t\":10,\"n\":1,\"p\":7,\"src\":\"main\",\"k\":\"app.start\"}\n\
             {\"t\":30,\"n\":3,\"p\":7,\"src\":\"main\",\"k\":\"run.failed\",\"l\":\"e\",\"msg\":\"boom\"}\n{\"t\":31,\"n\":4",
        )
        .unwrap();
        std::fs::write(dir.join("host-events.ndjson"), "{\"t\":20,\"n\":1,\"p\":9,\"src\":\"host\",\"k\":\"host.call.slow\"}\n").unwrap();
        let (events, notes) = read_events(&[dir.clone()]);
        let kinds: Vec<&str> = events.iter().map(|e| str_of(&e.v, "k")).collect();
        assert_eq!(kinds, ["app.start", "host.call.slow", "run.failed"]);
        assert_eq!(notes.len(), 1, "the torn last line is reported");
        assert_eq!(gaps(&events).len(), 1, "line 2 of pid 7 is missing");
        assert!(render(&events[2]).contains("ERR ") && render(&events[2]).ends_with("msg=boom"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
