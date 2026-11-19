import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSupervisor } from "../dist/runtime-supervisor.js";

async function skill(dir: string, name: string): Promise<string> {
  await mkdir(join(dir, name), { recursive: true });
  const file = join(dir, name, "SKILL.md");
  await writeFile(file, `---\nname: ${name}\ndescription: ${name} skill\n---\nBody`);
  return file;
}

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-placement-"));
  const agentDir = join(root, "agent");
  const shared = join(root, "skills");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const workspaces = await Promise.all(
    ["A", "B"].map(async (name) => {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      return { workspaceId: name, path, displayName: name };
    }),
  );
  const supervisor = new RuntimeSupervisor({ agentDir, sharedSkillDirs: [shared] });
  return { agentDir, shared, workspaces, supervisor };
}

async function skillsIn(file: string): Promise<unknown> {
  const settings = JSON.parse(await readFile(file, "utf8")) as { skills?: unknown };
  return settings.skills;
}

const enabledSkill = (
  snapshot: { skills: readonly { name: string; enabled: boolean }[] },
  name: string,
) => snapshot.skills.find((entry) => entry.name === name)?.enabled;

await test("a shared skill scoped to one project loads there and nowhere else", async (t) => {
  const { agentDir, shared, workspaces, supervisor } = await setup(t);
  const file = await skill(shared, "only-a");
  const [a, b] = workspaces;

  const before = await supervisor.getGlobalRuntimeSnapshot(workspaces);
  assert.deepEqual(
    before.placements?.find((entry) => entry.path === file),
    { kind: "skill", path: file, global: true, enabledIn: ["A", "B"] },
  );

  await supervisor.setResourcePlacement(
    "skill",
    file,
    { global: false, workspaceIds: ["A"] },
    workspaces,
  );

  assert.deepEqual(await skillsIn(join(agentDir, "settings.json")), ["-../skills/only-a"]);
  assert.deepEqual(await skillsIn(join(a!.path, ".pi", "settings.json")), ["../../skills/only-a"]);

  const after = await supervisor.getGlobalRuntimeSnapshot(workspaces, true);
  assert.deepEqual(after.placements?.find((entry) => entry.path === file)?.enabledIn, ["A"]);
  assert.equal(enabledSkill(await supervisor.refreshRuntime(a!), "only-a"), true);
  assert.equal(enabledSkill(await supervisor.refreshRuntime(b!), "only-a"), false);

  // Back to every project: the user `-` entry and the project entry are both gone.
  await supervisor.setResourcePlacement(
    "skill",
    file,
    { global: true, workspaceIds: [] },
    workspaces,
  );
  const reset = await supervisor.getGlobalRuntimeSnapshot(workspaces, true);
  assert.deepEqual(reset.placements?.find((entry) => entry.path === file)?.enabledIn, ["A", "B"]);
  assert.deepEqual(await skillsIn(join(a!.path, ".pi", "settings.json")), []);
});

await test("a global skill turned off in one project stays on in the others", async (t) => {
  const { agentDir, workspaces, supervisor } = await setup(t);
  const file = await skill(join(agentDir, "skills"), "everywhere");
  const [a, b] = workspaces;

  const offInA = await supervisor.setProjectResourceEnabled(a!, "skill", file, false);
  assert.equal(enabledSkill(offInA, "everywhere"), false);
  assert.equal(enabledSkill(await supervisor.refreshRuntime(b!), "everywhere"), true);
  assert.deepEqual(await skillsIn(join(a!.path, ".pi", "settings.json")), [
    "../../agent/skills/everywhere",
    "-../../agent/skills/everywhere",
  ]);

  const onInA = await supervisor.setProjectResourceEnabled(a!, "skill", file, true);
  assert.equal(enabledSkill(onInA, "everywhere"), true);
  assert.deepEqual(await skillsIn(join(a!.path, ".pi", "settings.json")), []);
});
