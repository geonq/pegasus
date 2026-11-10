import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { CatalogStorage, WorktreeCatalogEntry } from "@pi-gui/catalogs";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import { appWorktreeRootMatcher } from "../../electron/platform/worktrees/app-worktree-roots";
import { GitWorktreeManager } from "../../electron/platform/worktrees/worktree-manager";

const execFileAsync = promisify(execFile);

/**
 * Direct unit coverage for the destructive worktree lifecycle logic — the
 * transactional-create rollback, the branch cleanup on removal, and the startup
 * GC prune. Runs in Node (no Electron surface); every git command targets a
 * throwaway repo, never pi-gui itself.
 */

class FakeCatalog {
  private readonly byWorkspace = new Map<string, WorktreeCatalogEntry[]>();

  readonly worktrees = {
    listWorktrees: async (workspaceId?: string) => {
      const entries = workspaceId
        ? (this.byWorkspace.get(workspaceId) ?? [])
        : [...this.byWorkspace.values()].flat();
      return { worktrees: entries.map((entry) => ({ ...entry })) };
    },
    getWorktree: async (worktreeId: string) =>
      [...this.byWorkspace.values()].flat().find((entry) => entry.worktreeId === worktreeId),
    upsertWorktree: async (entry: WorktreeCatalogEntry) => {
      const bucket = this.byWorkspace.get(entry.workspaceId) ?? [];
      const next = bucket.filter((existing) => existing.worktreeId !== entry.worktreeId);
      next.push({ ...entry });
      this.byWorkspace.set(entry.workspaceId, next);
    },
    deleteWorktree: async (worktreeId: string) => {
      for (const [workspaceId, bucket] of this.byWorkspace) {
        this.byWorkspace.set(
          workspaceId,
          bucket.filter((entry) => entry.worktreeId !== worktreeId),
        );
      }
    },
    replaceWorkspaceWorktrees: async (
      workspaceId: string,
      entries: readonly WorktreeCatalogEntry[],
    ) => {
      this.byWorkspace.set(
        workspaceId,
        entries.map((entry) => ({ ...entry })),
      );
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function makeRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "seed.txt"), "seed\n");
  await git(repo, "add", "seed.txt");
  await git(repo, "commit", "-qm", "seed");
  return realpath(repo);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  const output = await git(repo, "branch", "--list", branch);
  return output.includes(branch);
}

function makeManager(appWorktreeRoot?: string): {
  manager: GitWorktreeManager;
  catalog: FakeCatalog;
} {
  const catalog = new FakeCatalog();
  const manager = new GitWorktreeManager({
    catalogStorage: catalog as unknown as CatalogStorage,
    ...(appWorktreeRoot ? { isAppWorktreePath: appWorktreeRootMatcher(appWorktreeRoot) } : {}),
  });
  return { manager, catalog };
}

test("rolls back a just-created worktree and its branch on failed thread creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-rollback-"));
  try {
    const repo = await makeRepo(root);
    const workspace: WorkspaceRef = { workspaceId: "ws", path: repo, displayName: "repo" };
    const { manager } = makeManager();

    const worktreePath = join(root, "worktrees", "repo", "roll-abc123");
    const branchName = "pi/roll-abc123";
    const created = await manager.createWorktree(workspace, {
      path: worktreePath,
      branchName,
      startPoint: "HEAD",
      displayName: "Roll",
    });
    expect(await pathExists(created.path)).toBe(true);
    expect(await branchExists(repo, branchName)).toBe(true);

    // Simulate the downstream failure path: roll the worktree back.
    await manager.destroyWorktree(workspace, { path: created.path, branchName });

    expect(await pathExists(created.path)).toBe(false);
    expect(await branchExists(repo, branchName)).toBe(false);
    const remaining = await manager.listWorktrees(workspace);
    expect(remaining.worktrees.some((entry) => entry.worktreeId === created.worktreeId)).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeWorktree deletes the merged pi/* branch but keeps unmerged work", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-remove-"));
  try {
    const repo = await makeRepo(root);
    const workspace: WorkspaceRef = { workspaceId: "ws", path: repo, displayName: "repo" };
    const { manager } = makeManager();

    const mergedPath = join(root, "worktrees", "repo", "merged-1");
    const merged = await manager.createWorktree(workspace, {
      path: mergedPath,
      branchName: "pi/merged-1",
      startPoint: "HEAD",
    });
    await manager.removeWorktree(workspace, merged.worktreeId);
    expect(await pathExists(merged.path)).toBe(false);
    expect(await branchExists(repo, "pi/merged-1")).toBe(false);

    const unmergedPath = join(root, "worktrees", "repo", "unmerged-1");
    const unmerged = await manager.createWorktree(workspace, {
      path: unmergedPath,
      branchName: "pi/unmerged-1",
      startPoint: "HEAD",
    });
    await writeFile(join(unmerged.path, "work.txt"), "unmerged work\n");
    await git(unmerged.path, "add", "work.txt");
    await git(unmerged.path, "commit", "-qm", "unmerged");
    await manager.removeWorktree(workspace, unmerged.worktreeId, { force: true });
    expect(await pathExists(unmerged.path)).toBe(false);
    // Safe delete must refuse the unmerged branch: leaked branch beats lost commits.
    expect(await branchExists(repo, "pi/unmerged-1")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruneOrphanedWorktrees removes clean merged orphans and fails closed for protected worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-prune-"));
  try {
    const repo = await makeRepo(root);
    const workspace: WorkspaceRef = { workspaceId: "ws", path: repo, displayName: "repo" };
    const { manager } = makeManager();
    const worktreeRoot = join(root, "worktrees");

    const referenced = await manager.createWorktree(workspace, {
      path: join(worktreeRoot, "repo", "referenced"),
      branchName: "pi/referenced",
      startPoint: "HEAD",
    });
    const orphan = await manager.createWorktree(workspace, {
      path: join(worktreeRoot, "repo", "orphan"),
      branchName: "pi/orphan",
      startPoint: "HEAD",
    });
    const dirty = await manager.createWorktree(workspace, {
      path: join(worktreeRoot, "repo", "dirty"),
      branchName: "pi/dirty",
      startPoint: "HEAD",
    });
    await writeFile(join(dirty.path, "scratch.txt"), "uncommitted\n");
    const unmerged = await manager.createWorktree(workspace, {
      path: join(worktreeRoot, "repo", "unmerged"),
      branchName: "pi/unmerged",
      startPoint: "HEAD",
    });
    await writeFile(join(unmerged.path, "work.txt"), "committed but unmerged\n");
    await git(unmerged.path, "add", "work.txt");
    await git(unmerged.path, "commit", "-qm", "unmerged work");
    const nonAppPath = join(worktreeRoot, "repo", "non-app");
    await git(repo, "worktree", "add", "-b", "feature/manual", nonAppPath, "HEAD");
    const nonAppId = await realpath(nonAppPath);
    const detachedPath = join(worktreeRoot, "repo", "detached");
    await git(repo, "worktree", "add", "--detach", detachedPath, "HEAD");
    const detachedId = await realpath(detachedPath);
    const ambiguousPath = join(worktreeRoot, "repo", "not-a-worktree");
    await mkdir(ambiguousPath, { recursive: true });
    const ambiguousId = await realpath(ambiguousPath);

    const result = await manager.pruneOrphanedWorktrees({
      worktreeRoot,
      referencedPaths: new Set([await realpath(repo), referenced.worktreeId]),
    });

    expect(await pathExists(orphan.path)).toBe(false);
    expect(await branchExists(repo, "pi/orphan")).toBe(false);
    expect(result.removed).toContain(orphan.worktreeId);

    expect(await pathExists(referenced.path)).toBe(true);
    expect(await pathExists(dirty.path)).toBe(true);
    expect(await branchExists(repo, "pi/dirty")).toBe(true);
    expect(result.skipped).toContain(dirty.worktreeId);

    expect(await pathExists(unmerged.path)).toBe(true);
    expect(await branchExists(repo, "pi/unmerged")).toBe(true);
    expect(result.skipped).toContain(unmerged.worktreeId);

    for (const protectedId of [nonAppId, detachedId, ambiguousId]) {
      expect(await pathExists(protectedId)).toBe(true);
      expect(result.skipped).toContain(protectedId);
    }
    expect(await branchExists(repo, "feature/manual")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("app worktree paths are matched inside the profile root only, even before it exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-roots-"));
  try {
    const isAppWorktreePath = appWorktreeRootMatcher(join(root, "worktrees"));
    expect(await isAppWorktreePath(join(root, "worktrees", "repo", "task-1"))).toBe(true);
    expect(await isAppWorktreePath(join(root, "worktrees"))).toBe(false);
    expect(await isAppWorktreePath(join(root, "worktrees-old", "repo", "task-1"))).toBe(false);
    expect(await isAppWorktreePath(join(root, "worktrees", "..", "repo"))).toBe(false);
    // Git reports resolved paths; a root reached through a symlink must still match.
    await mkdir(join(root, "real", "worktrees", "repo", "task-2"), { recursive: true });
    await symlink(
      join(root, "real"),
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const throughLink = appWorktreeRootMatcher(join(root, "linked", "worktrees"));
    expect(
      await throughLink(await realpath(join(root, "real", "worktrees", "repo", "task-2"))),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("folders list only the app worktrees they own and never remove the user's own checkouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-owner-"));
  try {
    const repo = await makeRepo(root);
    const userCheckout = join(root, "elsewhere", "feature");
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await git(repo, "worktree", "add", "-b", "feature/mine", userCheckout, "HEAD");
    const main: WorkspaceRef = { workspaceId: "main", path: repo, displayName: "repo" };
    const mine: WorkspaceRef = {
      workspaceId: "mine",
      path: await realpath(userCheckout),
      displayName: "feature",
    };
    const { manager } = makeManager(join(root, "worktrees"));

    const created = await manager.createWorktree(mine, {
      path: join(root, "worktrees", "repo", "task-1"),
      branchName: "pi/task-1",
      startPoint: "HEAD",
    });
    const linkedPaths = async (workspace: WorkspaceRef) =>
      (await manager.refreshWorktrees(workspace)).worktrees
        .filter((entry) => entry.kind === "linked")
        .map((entry) => entry.path);

    // The main checkout sees neither the user's checkout nor the worktree the other folder made.
    expect(await linkedPaths(main)).toEqual([]);
    expect(await linkedPaths(mine)).toEqual([created.path]);

    // Even a checkout no folder has opened, which the catalog does not know, is refused.
    const unopened = join(root, "elsewhere", "unopened");
    await git(repo, "worktree", "add", "-b", "feature/unopened", unopened, "HEAD");
    await expect(manager.removeWorktree(main, unopened)).rejects.toThrow(
      "Only worktrees created by Pegasus can be removed here.",
    );
    expect(await pathExists(unopened)).toBe(true);
    await manager.removeWorktree(mine, created.worktreeId);
    expect(await pathExists(created.path)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a user's checkout inside the app worktree folder still cannot be removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-managed-user-"));
  try {
    const repo = await makeRepo(root);
    const main: WorkspaceRef = { workspaceId: "main", path: repo, displayName: "repo" };
    const { manager } = makeManager(join(root, "worktrees"));
    const manual = join(root, "worktrees", "repo", "manual");
    await mkdir(join(root, "worktrees", "repo"), { recursive: true });
    await git(repo, "worktree", "add", "-b", "feature/manual", manual, "HEAD");

    await expect(manager.removeWorktree(main, manual)).rejects.toThrow(
      "Only worktrees created by Pegasus can be removed here.",
    );
    expect(await pathExists(manual)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the folder that creates a worktree keeps it even if another folder listed it first", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-claim-"));
  try {
    const repo = await makeRepo(root);
    const main: WorkspaceRef = { workspaceId: "main", path: repo, displayName: "repo" };
    const other: WorkspaceRef = {
      workspaceId: "other",
      path: join(root, "other"),
      displayName: "other",
    };
    await git(repo, "worktree", "add", "-b", "feature/other", other.path, "HEAD");
    const { manager } = makeManager(join(root, "worktrees"));
    const created = join(root, "worktrees", "repo", "task-1");
    await mkdir(dirname(created), { recursive: true });
    await git(repo, "worktree", "add", "-b", "pi/task-1", created, "HEAD");
    const createdPath = await realpath(created);

    // Another folder refreshes between `git worktree add` and the creator's refresh.
    await manager.refreshWorktrees({ ...other, path: await realpath(other.path) });
    expect((await manager.listWorktrees(other)).worktrees.map((entry) => entry.path)).toContain(
      createdPath,
    );

    const claimed = await manager.refreshWorktrees(main, { claimPath: createdPath });
    expect(claimed.worktrees.map((entry) => entry.path)).toContain(createdPath);
    expect((await manager.listWorktrees(other)).worktrees.map((entry) => entry.path)).not.toContain(
      createdPath,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Repo with a tracked .gitignore, ignored .env/.vscode files and a .worktreeinclude. */
async function makeSetupRepo(root: string, extra: Record<string, string> = {}): Promise<string> {
  const repo = await makeRepo(root);
  await writeFile(join(repo, ".gitignore"), ".env\n.vscode/\nnode_modules/\nsecret/\n");
  await writeFile(join(repo, ".worktreeinclude"), "# local config\n.env\n.vscode/\n");
  await writeFile(join(repo, ".env"), "TOKEN=1\n");
  await mkdir(join(repo, ".vscode"), { recursive: true });
  await writeFile(join(repo, ".vscode", "settings.json"), "{}\n");
  await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
  await writeFile(join(repo, "node_modules", "dep", "index.js"), "1\n");
  for (const [name, text] of Object.entries(extra)) {
    await writeFile(join(repo, name), text);
  }
  await git(repo, "add", ".gitignore", ".worktreeinclude", ...Object.keys(extra));
  await git(repo, "commit", "-qm", "setup config");
  return repo;
}

test("new worktree gets the ignored files listed in .worktreeinclude, nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-include-"));
  try {
    const repo = await makeSetupRepo(root);
    await mkdir(join(repo, "secret"), { recursive: true });
    await writeFile(join(repo, "secret", "key"), "k\n");
    const workspace: WorkspaceRef = { workspaceId: "ws", path: repo, displayName: "repo" };
    const { manager } = makeManager();
    const created = await manager.createWorktree(workspace, {
      path: join(root, "worktrees", "repo", "inc-1"),
      branchName: "pi/inc-1",
    });
    await manager.whenSetupSettled(created.path);

    expect(manager.setupFor(created.path)).toBeUndefined();
    expect(await readFile(join(created.path, ".env"), "utf8")).toBe("TOKEN=1\n");
    expect(await pathExists(join(created.path, ".vscode", "settings.json"))).toBe(true);
    expect(await pathExists(join(created.path, "secret"))).toBe(false);
    expect(await pathExists(join(created.path, "node_modules"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(".worktreeinclude never copies tracked files or paths outside the repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-escape-"));
  try {
    const repo = await makeSetupRepo(root);
    await writeFile(join(root, "outside.txt"), "outside\n");
    await writeFile(
      join(repo, ".worktreeinclude"),
      "../outside.txt\n/etc/passwd\nseed.txt\n.gitignore\n.env\n",
    );
    const workspace: WorkspaceRef = { workspaceId: "ws", path: repo, displayName: "repo" };
    const { manager } = makeManager();
    const dest = join(root, "worktrees", "repo", "esc-1");
    const created = await manager.createWorktree(workspace, { path: dest, branchName: "pi/esc-1" });
    await manager.whenSetupSettled(created.path);

    expect(manager.setupFor(created.path)).toBeUndefined();
    expect(await pathExists(join(root, "worktrees", "outside.txt"))).toBe(false);
    expect(await pathExists(join(created.path, ".env"))).toBe(true);
    // Tracked files come from the checkout, untouched by the copy.
    expect((await readFile(join(created.path, "seed.txt"), "utf8")).trim()).toBe("seed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repo setup command waits for approval, then runs once approved", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-setup-"));
  try {
    const repo = await makeSetupRepo(root, {
      "orca.yaml":
        "scripts:\n  setup: |\n    node -e \"require('fs').writeFileSync('setup-ran.txt','ok')\"\n",
    });
    const workspace: WorkspaceRef = { workspaceId: "ws", path: repo, displayName: "repo" };
    const changes: string[] = [];
    const manager = new GitWorktreeManager({
      catalogStorage: new FakeCatalog() as unknown as CatalogStorage,
      setupTrustFilePath: join(root, "trust.json"),
      onSetupChange: () => changes.push("change"),
    });
    const created = await manager.createWorktree(workspace, {
      path: join(root, "worktrees", "repo", "setup-1"),
      branchName: "pi/setup-1",
    });
    await manager.whenSetupSettled(created.path);

    expect(manager.setupFor(created.path)?.state).toBe("needs-approval");
    expect(await pathExists(join(created.path, "setup-ran.txt"))).toBe(false);
    expect(await pathExists(join(created.path, ".env"))).toBe(true);

    await manager.approveSetup(workspace, created.path);
    await manager.whenSetupSettled(created.path);
    expect(manager.setupFor(created.path)).toBeUndefined();
    expect(await readFile(join(created.path, "setup-ran.txt"), "utf8")).toBe("ok");
    expect(changes.length).toBeGreaterThan(1);

    // Approval is per exact command: a changed command asks again.
    await writeFile(
      join(repo, "orca.yaml"),
      'scripts:\n  setup: node -e "process.exit(0)" && echo changed\n',
    );
    const second = await manager.createWorktree(workspace, {
      path: join(root, "worktrees", "repo", "setup-2"),
      branchName: "pi/setup-2",
    });
    await manager.whenSetupSettled(second.path);
    expect(manager.setupFor(second.path)?.state).toBe("needs-approval");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing setup command is reported on the worktree, and sharedDirectories are linked", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-fail-"));
  try {
    const repo = await makeSetupRepo(root, {
      "orca.yaml":
        'worktree:\n  sharedDirectories:\n    - node_modules\n    - ../escape\nscripts:\n  setup: node -e "process.exit(3)"\n',
    });
    const workspace: WorkspaceRef = { workspaceId: "ws", path: repo, displayName: "repo" };
    const manager = new GitWorktreeManager({
      catalogStorage: new FakeCatalog() as unknown as CatalogStorage,
      setupTrustFilePath: join(root, "trust.json"),
    });
    const created = await manager.createWorktree(workspace, {
      path: join(root, "worktrees", "repo", "fail-1"),
      branchName: "pi/fail-1",
    });
    await manager.whenSetupSettled(created.path);
    // The unsafe "../escape" entry fails setup loudly; the worktree itself still exists.
    expect(manager.setupFor(created.path)).toMatchObject({ state: "failed" });
    expect(await pathExists(created.path)).toBe(true);
    expect(await pathExists(join(created.path, "node_modules", "dep", "index.js"))).toBe(true);

    await writeFile(join(repo, "orca.yaml"), 'scripts:\n  setup: node -e "process.exit(3)"\n');
    const third = await manager.createWorktree(workspace, {
      path: join(root, "worktrees", "repo", "fail-2"),
      branchName: "pi/fail-2",
    });
    await manager.whenSetupSettled(third.path);
    expect(manager.setupFor(third.path)?.state).toBe("needs-approval");
    await manager.approveSetup(workspace, third.path);
    await manager.whenSetupSettled(third.path);
    const failed = manager.setupFor(third.path);
    expect(failed?.state).toBe("failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
