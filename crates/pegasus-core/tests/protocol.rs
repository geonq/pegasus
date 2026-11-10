//! The checked-in TypeScript bindings must equal what the Rust schema generates.
//! Regenerate with `corepack pnpm protocol:emit` (sets PEGASUS_EMIT_TS=1).
use pegasus_core::protocol::ts_bindings;

#[test]
fn ts_bindings_are_current() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/host-protocol/src/generated.ts");
    let want = ts_bindings();
    if std::env::var("PEGASUS_EMIT_TS").is_ok_and(|v| v == "1") {
        std::fs::write(path, &want).unwrap();
        return;
    }
    let have = std::fs::read_to_string(path).unwrap_or_default().replace("\r\n", "\n");
    assert!(have == want, "packages/host-protocol/src/generated.ts is stale: run `corepack pnpm protocol:emit`");
}
