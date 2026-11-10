// Regenerates packages/host-protocol/src/generated.ts from crates/pegasus-core/src/protocol.rs.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const manifest = fileURLToPath(new URL("../crates/Cargo.toml", import.meta.url));
const result = spawnSync(
  "cargo",
  ["test", "--manifest-path", manifest, "-q", "-p", "pegasus-core", "--test", "protocol"],
  { stdio: "inherit", env: { ...process.env, PEGASUS_EMIT_TS: "1" }, windowsHide: true },
);
process.exitCode = result.status ?? 1;
