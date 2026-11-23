import type { DesktopAppState } from "../../contracts/desktop-state";
import { filterRemoteState } from "./remote-desktop-policy";
import { createRemoteWorkspaceFolders } from "./remote-workspace-folders";

/** Adds only registered projects contained by explicit create roots to one device's view. */
export class RemoteWorkspaceStateProjector {
  private readonly futureFolders: ReturnType<typeof createRemoteWorkspaceFolders>;
  private readonly futureRootIds: readonly string[];
  private latestObservedRevision = -1;
  private latestProjectedRevision = -1;
  private latestProjectedState: DesktopAppState | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspaceIds: Set<string>,
    futureWorkspaceRootPaths: ReadonlyMap<string, string>,
    /**
     * The owner's paired phone sees every project of this PC, including ones added after pairing
     * (pairing grants "all workspaces"; a snapshot of the ids hid every later project).
     */
    private readonly grantAllWorkspaces = false,
  ) {
    this.futureFolders = createRemoteWorkspaceFolders(futureWorkspaceRootPaths);
    this.futureRootIds = [...futureWorkspaceRootPaths.keys()];
  }

  enqueueEvent(
    state: DesktopAppState,
    publish: (projected: DesktopAppState) => void,
  ): Promise<void> {
    const revision = this.observeRevision(state);
    const task = this.enqueue(async () => {
      if (revision < this.latestObservedRevision || revision <= this.latestProjectedRevision)
        return;
      const projection = await this.project(state, revision);
      if (!projection || revision < this.latestObservedRevision) return;
      publish(this.commit(projection, revision));
    });
    return task;
  }

  async projectResponse(state: DesktopAppState): Promise<DesktopAppState> {
    const revision = this.observeRevision(state);
    await this.enqueue(async () => {
      if (revision < this.latestObservedRevision || revision < this.latestProjectedRevision) return;
      const projection = await this.project(state, revision);
      if (!projection || revision < this.latestObservedRevision) return;
      this.commit(projection, revision);
    });

    // An event may arrive while realpath checks are pending. Wait until the newest observed
    // snapshot has also passed through the same queue before returning a getState result.
    while (true) {
      const currentTail = this.tail;
      await currentTail;
      if (currentTail === this.tail) break;
    }
    if (
      this.latestProjectedState &&
      this.latestProjectedRevision >= Math.max(revision, this.latestObservedRevision)
    ) {
      return this.latestProjectedState;
    }
    throw new Error("The remote workspace state could not be projected safely.");
  }

  private observeRevision(state: DesktopAppState): number {
    const revision = state.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TypeError("Remote workspace state revision is invalid.");
    }
    this.latestObservedRevision = Math.max(this.latestObservedRevision, revision);
    return revision;
  }

  private async project(
    state: DesktopAppState,
    revision: number,
  ): Promise<{ readonly state: DesktopAppState; readonly grants: readonly string[] } | undefined> {
    const grants: string[] = [];
    for (const workspace of state.workspaces) {
      if (this.workspaceIds.has(workspace.id)) continue;
      if (this.grantAllWorkspaces) {
        grants.push(workspace.id);
        continue;
      }
      for (const rootId of this.futureRootIds) {
        if (await this.futureFolders.contains(rootId, workspace.path, true)) {
          grants.push(workspace.id);
          break;
        }
      }
      if (revision < this.latestObservedRevision) return undefined;
    }
    if (revision < this.latestObservedRevision) return undefined;
    return { state, grants };
  }

  private commit(
    projection: { readonly state: DesktopAppState; readonly grants: readonly string[] },
    revision: number,
  ): DesktopAppState {
    for (const workspaceId of projection.grants) this.workspaceIds.add(workspaceId);
    const state = filterRemoteState(projection.state, this.workspaceIds);
    this.latestProjectedState = state;
    this.latestProjectedRevision = revision;
    return state;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const task = this.tail.then(work, work);
    this.tail = task.catch(() => undefined);
    return task;
  }
}
