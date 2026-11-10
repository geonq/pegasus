//! Pegasus-rs spike: sidebar of real pi chats grouped by project + virtualized transcript.
//! Headless only: `pegasus-rs --snap out.png [--scene long|worst] [--size WxH]`; `--bench` prints timings.
mod store;
use rune::tok::{self, radius, type_};
use rune::{AppSpec, Cx, El, GrowthSpec, ScrollSpec, col, el, row, text};
use std::path::{Path, PathBuf};
use std::time::Instant;
use store::{Msg, Project, Role};

const ROOT: &str = r"D:\Pi\pi-ecosystem\.state\agent\sessions";

struct State { projects: Vec<Project>, sel: Option<PathBuf>, msgs: Vec<Msg>, scan_ms: f64, load_ms: f64 }

impl Default for State {
    fn default() -> Self {
        let t = Instant::now();
        let projects = store::scan(Path::new(ROOT));
        let mut s = State { projects, sel: None, msgs: vec![], scan_ms: t.elapsed().as_secs_f64() * 1e3, load_ms: 0.0 };
        s.select(None);
        s
    }
}

impl State {
    /// None = the largest file on disk (the longest real chat).
    fn select(&mut self, p: Option<PathBuf>) {
        let p = p.or_else(|| {
            self.projects.iter().flat_map(|p| &p.chats)
                .max_by_key(|c| std::fs::metadata(&c.path).map(|m| m.len()).unwrap_or(0)).map(|c| c.path.clone())
        });
        let t = Instant::now();
        self.msgs = p.as_deref().map(store::load).unwrap_or_default();
        self.load_ms = t.elapsed().as_secs_f64() * 1e3;
        self.sel = p;
    }
}

/// Synthetic worst-case rows (fixture, not real chats): unbreakable URL, emoji, CJK, one char.
fn worst(s: &mut State) {
    let long = "https://example.com/".to_string() + &"a".repeat(400);
    let fx = ["x", "日本語のテキスト、とても長い行がここに続きます。🚀🔥 émoji ÅÄÖ", long.as_str(), "line\n\n\nwith\nmany\nbreaks"];
    let mut v: Vec<Msg> = fx.iter().map(|t| Msg { role: Role::User, text: t.to_string() }).collect();
    v.extend(s.msgs.drain(..).take(20));
    s.msgs = v;
}

fn role_label(r: Role) -> (&'static str, usize) {
    match r { Role::User => ("You", 1), Role::Assistant => ("Pegasus", 0), Role::Tool => ("tool", 3), Role::Result => ("result", 3) }
}

fn sidebar(s: &State, t: &tok::Theme) -> El {
    let mut list = col().key("side-list").px(8.0).py(8.0);
    for (pi, p) in s.projects.iter().enumerate() {
        list = list.child(text(p.name.clone()).font(type_::SECTION).color(t.text_secondary).truncate()
            .key(format!("proj-{pi}")).px(8.0).py(6.0).h(30.0));
        for c in &p.chats {
            let on = s.sel.as_deref() == Some(c.path.as_path());
            let path = c.path.clone();
            let title = if c.title.is_empty() { "(untitled)".to_string() } else { c.title.clone() };
            list = list.child(
                row().key(c.path.to_string_lossy().to_string()).h(28.0).px(8.0).center_y().radius(radius::SM)
                    .fill(if on { t.control_off } else { t.card })
                    .on_press(move |s: &mut State| s.select(Some(path.clone())))
                    .child(text(title).font(type_::BODY).color(t.text).truncate().grow(1.0)),
            );
        }
    }
    // List navigation is high frequency: no motion on selection changes.
    col().key("sidebar").w(280.0).h_full().fill(t.card).min_h(0.0)
        .child(row().h(44.0).px(16.0).center_y().child(text("Chats").font(type_::TITLE).color(t.text)))
        .child(list.scroll(ScrollSpec { stick_bottom: false }).shrink().min_h(0.0).instant_changes())
}

fn transcript(s: &State, t: &tok::Theme) -> El {
    let mut stack = col().key("tx").growth(GrowthSpec::default()).virtualize(64.0);
    for (i, m) in s.msgs.iter().enumerate() {
        let (label, accent) = role_label(m.role);
        let mono = matches!(m.role, Role::Tool | Role::Result);
        let body = text(m.text.clone()).wrap()
            .font(if mono { type_::MONO_CAPTION } else { type_::BODY })
            .color(if mono { t.text_secondary } else { t.text });
        stack = stack.child(
            // Virtual rows need internal vertical padding, not margins or gaps.
            col().key(format!("m{i}")).px(20.0).py(8.0).gap(2.0)
                .child(text(label).font(type_::SECTION).color(tok::accent(accent, true)))
                .child(body),
        );
    }
    let title = s.sel.as_deref().and_then(|p| s.projects.iter().flat_map(|q| &q.chats).find(|c| c.path == p))
        .map(|c| c.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| "(untitled)".into());
    let header = row().h(44.0).px(20.0).center_y().gap(8.0)
        .child(text(title).font(type_::TITLE).color(t.text).truncate().grow(1.0))
        .child(text(format!("{} messages", s.msgs.len())).font(type_::LABEL).color(t.text_secondary));
    // Empty state names what is missing; long lines are capped at a readable width, centred.
    let body = if s.msgs.is_empty() {
        col().grow(1.0).center().child(text("No messages in this chat").font(type_::BODY).color(t.text_secondary))
    } else {
        col().grow(1.0).min_h(0.0).items_center()
            .child(col().key("tx-scroll").scroll(ScrollSpec { stick_bottom: false }).shrink().min_h(0.0).w_full().max_w(780.0).child(stack))
    };
    col().key("main").grow(1.0).h_full().min_h(0.0).min_w(0.0).child(header).child(body)
}

fn view(s: &State, _: &mut Cx<State>) -> El {
    let t = tok::theme(true);
    row().w_full().h_full().fill(t.bg).child(sidebar(s, &t)).child(el().w(1.0).h_full().fill(t.separator)).child(transcript(s, &t))
}

fn main() {
    if std::env::args().any(|a| a == "--bench") { return bench(); }
    rune::run(AppSpec::<State> {
        scenes: &[("long", |_| {}), ("worst", worst)],
        ..AppSpec::new("Pegasus (Rust spike)", (1100.0, 720.0), State::default, view)
    });
}

fn bench() {
    use rune::{Env, Runtime};
    let t0 = Instant::now();
    let st = State::default();
    println!("chats={} projects={} msgs={}", st.projects.iter().map(|p| p.chats.len()).sum::<usize>(), st.projects.len(), st.msgs.len());
    println!("scan_ms={:.1} load_largest_ms={:.1}", st.scan_ms, st.load_ms);
    let mut rt = Runtime::new(st, view, (1100.0, 720.0), Env { system_dark: true, scale: 1.0 });
    let t = Instant::now(); rt.frame(0.0);
    println!("first_frame_cpu_ms={:.1}", t.elapsed().as_secs_f64() * 1e3);
    let mut v = vec![];
    for i in 0..120 {
        let t = Instant::now();
        if i % 2 == 0 { rt.wheel(700.0, 400.0, 120.0); }
        rt.frame(1.0 / 60.0);
        v.push(t.elapsed().as_secs_f64() * 1e3);
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("scroll_frame_cpu_ms median={:.2} p95={:.2} max={:.2}", v[60], v[113], v[119]);
    println!("total_ms={:.1}", t0.elapsed().as_secs_f64() * 1e3);
}
