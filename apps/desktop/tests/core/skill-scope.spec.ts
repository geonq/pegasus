import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

const proofDir = process.env.PI_APP_SKILL_SCOPE_PROOF_DIR;

async function captureProof(window: Page, filename: string): Promise<void> {
  if (!proofDir) return;
  await mkdir(proofDir, { recursive: true });
  await window.screenshot({ path: join(proofDir, filename) });
}

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} test skill.\n---\nInstructions.\n`,
  );
}

async function skillsIn(file: string): Promise<string[]> {
  const settings = JSON.parse(await readFile(file, "utf8")) as { skills?: string[] };
  return settings.skills ?? [];
}

async function showScope(window: Page, label: string): Promise<void> {
  await window.getByRole("button", { name: "Show skills and extensions for" }).click();
  await window.getByRole("menuitemradio", { name: label, exact: true }).click();
}

function group(window: Page, label: string) {
  return window
    .getByTestId("skills-list")
    .locator(".settings-section")
    .filter({ has: window.locator(".settings-section__title", { hasText: label }) });
}

function skillSwitch(window: Page, groupLabel: string, title: string) {
  return group(window, groupLabel).getByRole("switch", { name: `Enable ${title}` });
}

test("skills and extensions: Global view, project-only skills, per-project switches", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  // The shared folder Pegasus syncs between machines sits next to pi's agent folder.
  const sharedSkills = join(userDataDir, "skills");
  await writeSkill(sharedSkills, "lecture-notes");
  await writeSkill(join(agentDir, "skills"), "everywhere-helper");
  const projectA = await makeWorkspace("scope-project-a");
  const projectB = await makeWorkspace("scope-project-b");
  const nameA = basename(projectA);
  const nameB = basename(projectB);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [projectA, projectB],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(window.getByTestId("skills-surface")).toBeVisible();

    // Opens on Global: everything that loads in every project, the shared folder included.
    await expect(
      window.getByRole("button", { name: "Show skills and extensions for" }),
    ).toContainText("Global");
    await expect(skillSwitch(window, "Global", "Lecture Notes")).toBeChecked();
    await expect(skillSwitch(window, "Global", "Everywhere Helper")).toBeChecked();
    await captureProof(window, "1-global.png");

    // Scope the shared skill to project A with "Where it loads".
    await group(window, "Global")
      .getByRole("button", { name: /Lecture Notes/ })
      .click();
    await window.getByRole("button", { name: "Where it loads" }).click();
    const popover = window.locator(".glass-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toHaveCSS("backdrop-filter", /blur/);
    await popover.getByRole("menuitemcheckbox", { name: nameA }).click();
    await expect(window.getByRole("button", { name: "Where it loads" })).toContainText(
      `Only in ${nameA}`,
    );
    await captureProof(window, "2-where-it-loads.png");
    // Escape closes the menu only; the detail page stays open.
    await window.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await window.getByRole("button", { name: "All skills" }).click();
    await expect(group(window, "Global").locator(".resource-row__badge")).toHaveText(
      `Only in ${nameA}`,
    );

    // What pi was told: off in the user settings, listed in A's own settings, untouched in B.
    expect(await skillsIn(join(agentDir, "settings.json"))).toContain("-../skills/lecture-notes");
    const projectSkills = await skillsIn(join(projectA, ".pi", "settings.json"));
    expect(projectSkills).toHaveLength(1);
    expect(projectSkills[0]).toMatch(/skills\/lecture-notes$/);

    // Project A loads it; project B lists it switched off.
    await showScope(window, nameA);
    await expect(skillSwitch(window, "Global (inherited)", "Lecture Notes")).toBeChecked();
    await captureProof(window, "3-project-a.png");
    await showScope(window, nameB);
    await expect(skillSwitch(window, "Global (inherited)", "Lecture Notes")).not.toBeChecked();

    // A global skill turned off in A stays on in B.
    await showScope(window, nameA);
    const helperInA = skillSwitch(window, "Global (inherited)", "Everywhere Helper");
    await expect(helperInA).toBeChecked();
    await helperInA.click();
    await expect(helperInA).not.toBeChecked();
    await captureProof(window, "4-project-a-helper-off.png");
    await showScope(window, nameB);
    await expect(skillSwitch(window, "Global (inherited)", "Everywhere Helper")).toBeChecked();
    await captureProof(window, "5-project-b.png");
    await showScope(window, "Global");
    await expect(skillSwitch(window, "Global", "Everywhere Helper")).toBeChecked();
  } finally {
    await harness.close();
  }
});
