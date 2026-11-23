import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createEmptyDesktopAppState, type WorkspaceRecord } from "../../contracts/desktop-state";
import { RemoteWorkspaceStateProjector } from "../../electron/remote/remote-workspace-state-projector";

function workspace(id: string, folderPath: string): WorkspaceRecord {
  return {
    id,
    name: id,
    path: folderPath,
    lastOpenedAt: "2026-10-21T00:00:00.000Z",
    kind: "primary",
    sessions: [],
  };
}

test("future workspace grants use only contained real directories and publish the latest catalog revision", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-remote-state-projection-"));
  const projectsRoot = path.join(temporaryRoot, "projects");
  const knownPath = path.join(projectsRoot, "known");
  const futurePath = path.join(projectsRoot, "NextSemis");
  const siblingPath = path.join(temporaryRoot, "private");
  const linkPath = path.join(projectsRoot, "linked-private");
  await mkdir(knownPath, { recursive: true });
  await mkdir(futurePath);
  await mkdir(siblingPath);
  try {
    await symlink(siblingPath, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch {
    await rm(temporaryRoot, { recursive: true, force: true });
    test.skip(true, "This host cannot create a directory symlink for the containment check.");
    return;
  }

  try {
    const scope = new Set(["known"]);
    const projector = new RemoteWorkspaceStateProjector(
      scope,
      new Map([["projects", projectsRoot]]),
    );
    const first = {
      ...createEmptyDesktopAppState(),
      revision: 1,
      workspaces: [
        workspace("known", knownPath),
        workspace("future", futurePath),
        workspace("sibling", siblingPath),
        workspace("linked-private", linkPath),
      ],
    };
    const initial = await projector.projectResponse(first);
    expect(initial.workspaces.map(({ id }) => id)).toEqual(["known", "future"]);
    expect(scope).toEqual(new Set(["known", "future"]));

    const nextProjectPath = path.join(projectsRoot, "CreatedOnWindows");
    await mkdir(nextProjectPath);
    const liveState = {
      ...first,
      revision: 2,
      workspaces: [...first.workspaces, workspace("created-on-windows", nextProjectPath)],
    };
    const liveProjection = await projector.projectResponse(liveState);
    expect(liveProjection.workspaces.map(({ id }) => id)).toContain("created-on-windows");
    const events: number[] = [];
    const staleState = {
      ...liveState,
      revision: 3,
      workspaces: [...liveState.workspaces, workspace("stale", futurePath)],
    };
    const newestState = {
      ...liveState,
      revision: 4,
      workspaces: [...liveState.workspaces, workspace("newest", futurePath)],
    };
    const pendingOlder = projector.enqueueEvent(staleState, (state) => events.push(state.revision));
    const pendingNewer = projector.enqueueEvent(newestState, (state) =>
      events.push(state.revision),
    );
    await Promise.all([pendingOlder, pendingNewer]);
    const projectedNewest = await projector.projectResponse(newestState);
    expect(events).toEqual([4]);
    expect(projectedNewest.workspaces.map(({ id }) => id)).toContain("created-on-windows");
    expect(projectedNewest.workspaces.map(({ id }) => id)).toContain("newest");
    expect(scope.has("stale")).toBe(false);
    expect(projectedNewest.workspaces.map(({ id }) => id)).not.toContain("sibling");
    expect(projectedNewest.workspaces.map(({ id }) => id)).not.toContain("linked-private");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a paired phone sees projects added after pairing; other remote devices keep their scope", async () => {
  const state = {
    ...createEmptyDesktopAppState(),
    revision: 1,
    workspaces: [workspace("old", "C:\\old"), workspace("talking", "D:\\talking")],
  };
  const phoneScope = new Set(["old"]);
  const phone = new RemoteWorkspaceStateProjector(phoneScope, new Map(), true);
  expect((await phone.projectResponse(state)).workspaces.map(({ id }) => id)).toEqual([
    "old",
    "talking",
  ]);
  expect(phoneScope).toEqual(new Set(["old", "talking"]));

  const macScope = new Set(["old"]);
  const mac = new RemoteWorkspaceStateProjector(macScope, new Map());
  expect((await mac.projectResponse(state)).workspaces.map(({ id }) => id)).toEqual(["old"]);
  expect(macScope).toEqual(new Set(["old"]));
});
