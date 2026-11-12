import type { DesktopAppState, SessionRecord, WorkspaceRecord } from "./desktop-state";

/**
 * A window's copy of DesktopAppState moves forward by patches: only the top-level keys, record
 * entries, workspaces and sessions that changed cross the process boundary. A patch is valid only
 * on the state it was diffed against (`baseRevision`); a client in any other state pulls a full
 * state instead of guessing, so a missed, reordered or duplicated patch cannot leave it drifted.
 */
export interface DesktopStatePatch {
  readonly version: 1;
  /** Position in this window's patch stream; restarts at 1 after every full state. */
  readonly sequence: number;
  /** Revision of the state this patch applies on top of. */
  readonly baseRevision: number;
  /** Revision of the state after the patch. */
  readonly revision: number;
  /** Top-level keys whose value changed (never workspaces, never record-valued keys). */
  readonly set: Readonly<Record<string, unknown>>;
  /** Record-valued top-level keys (maps by workspace or session id): entries to set and delete. */
  readonly maps: Readonly<
    Record<string, { readonly set: Readonly<Record<string, unknown>>; readonly del: readonly string[] }>
  >;
  /** Present when any workspace or session changed. */
  readonly workspaces?: WorkspacesPatch;
}

export interface WorkspacesPatch {
  /** Final order of workspace ids. */
  readonly order: readonly string[];
  /** Added or changed workspaces; unchanged ones are not listed. */
  readonly upserts: readonly WorkspaceUpsert[];
}

export interface WorkspaceUpsert {
  /** The workspace's own fields; absent when only its sessions changed. */
  readonly record?: Omit<WorkspaceRecord, "sessions">;
  /** Final order of this workspace's session ids; absent when unchanged. */
  readonly sessionOrder?: readonly string[];
  readonly id: string;
  readonly sessions: readonly SessionRecord[];
}

type Json = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality with an identity shortcut; state is replaced, never mutated, so identity usually decides. */
export function valueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => valueEqual(item, right[index]))
    );
  }
  if (Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      valueEqual((left as Json)[key], (right as Json)[key]),
  );
}

function withoutSessions(workspace: WorkspaceRecord): Omit<WorkspaceRecord, "sessions"> {
  const { sessions: _sessions, ...rest } = workspace;
  void _sessions;
  return rest;
}

function diffWorkspaces(
  previous: readonly WorkspaceRecord[],
  next: readonly WorkspaceRecord[],
): WorkspacesPatch | undefined {
  if (previous === next) return undefined;
  const before = new Map(previous.map((workspace) => [workspace.id, workspace]));
  const upserts: WorkspaceUpsert[] = [];
  for (const workspace of next) {
    const old = before.get(workspace.id);
    if (old === workspace) continue;
    if (!old) {
      upserts.push({
        id: workspace.id,
        record: withoutSessions(workspace),
        sessionOrder: workspace.sessions.map((session) => session.id),
        sessions: workspace.sessions,
      });
      continue;
    }
    const oldSessions = new Map(old.sessions.map((session) => [session.id, session]));
    const changedSessions = workspace.sessions.filter(
      (session) => !valueEqual(oldSessions.get(session.id), session),
    );
    const recordChanged = !valueEqual(withoutSessions(old), withoutSessions(workspace));
    const orderChanged =
      old.sessions.length !== workspace.sessions.length ||
      old.sessions.some((session, index) => session.id !== workspace.sessions[index]?.id);
    if (!recordChanged && !orderChanged && changedSessions.length === 0) continue;
    upserts.push({
      id: workspace.id,
      ...(recordChanged ? { record: withoutSessions(workspace) } : {}),
      ...(orderChanged ? { sessionOrder: workspace.sessions.map((session) => session.id) } : {}),
      sessions: changedSessions,
    });
  }
  const orderChanged =
    previous.length !== next.length ||
    previous.some((workspace, index) => workspace.id !== next[index]?.id);
  if (upserts.length === 0 && !orderChanged) return undefined;
  return { order: next.map((workspace) => workspace.id), upserts };
}

/**
 * The patch that turns `previous` into `next`, or null when nothing but the revision changed
 * (the caller then sends nothing and keeps `previous` as the client's state).
 */
export function diffDesktopState(
  previous: DesktopAppState,
  next: DesktopAppState,
  sequence: number,
): DesktopStatePatch | null {
  const set: Record<string, unknown> = {};
  const maps: Record<string, { set: Record<string, unknown>; del: string[] }> = {};
  const before = previous as unknown as Json;
  const after = next as unknown as Json;
  let changed = false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "workspaces" || key === "revision") continue;
    const oldValue = before[key];
    const newValue = after[key];
    if (oldValue === newValue) continue;
    if (isPlainObject(oldValue) && isPlainObject(newValue)) {
      const entries: { set: Record<string, unknown>; del: string[] } = { set: {}, del: [] };
      for (const entryKey of Object.keys(newValue)) {
        if (!valueEqual(oldValue[entryKey], newValue[entryKey])) {
          entries.set[entryKey] = newValue[entryKey];
        }
      }
      for (const entryKey of Object.keys(oldValue)) {
        if (!Object.prototype.hasOwnProperty.call(newValue, entryKey)) entries.del.push(entryKey);
      }
      if (Object.keys(entries.set).length > 0 || entries.del.length > 0) {
        maps[key] = entries;
        changed = true;
      }
      continue;
    }
    if (!valueEqual(oldValue, newValue)) {
      set[key] = newValue;
      changed = true;
    }
  }
  const workspaces = diffWorkspaces(previous.workspaces, next.workspaces);
  if (!changed && !workspaces) return null;
  return {
    version: 1,
    sequence,
    baseRevision: previous.revision,
    revision: next.revision,
    set,
    maps,
    ...(workspaces ? { workspaces } : {}),
  };
}

function applyWorkspaces(
  current: readonly WorkspaceRecord[],
  patch: WorkspacesPatch,
): readonly WorkspaceRecord[] {
  const byId = new Map(current.map((workspace) => [workspace.id, workspace]));
  for (const upsert of patch.upserts) {
    const old = byId.get(upsert.id);
    const record = upsert.record ?? (old ? withoutSessions(old) : undefined);
    if (!record) continue;
    const sessionsById = new Map((old?.sessions ?? []).map((session) => [session.id, session]));
    for (const session of upsert.sessions) sessionsById.set(session.id, session);
    const order = upsert.sessionOrder ?? old?.sessions.map((session) => session.id) ?? [];
    const sessions = order
      .map((id) => sessionsById.get(id))
      .filter((session): session is SessionRecord => session !== undefined);
    // An untouched session keeps its identity so selectors on it do not fire.
    const sameSessions =
      old !== undefined &&
      sessions.length === old.sessions.length &&
      sessions.every((session, index) => session === old.sessions[index]);
    byId.set(upsert.id, {
      ...(old && !upsert.record ? old : record),
      sessions: sameSessions ? old.sessions : sessions,
    } as WorkspaceRecord);
  }
  return patch.order
    .map((id) => byId.get(id))
    .filter((workspace): workspace is WorkspaceRecord => workspace !== undefined);
}

/** The state after `patch`. Untouched keys, entries, workspaces and sessions keep their identity. */
export function applyDesktopStatePatch(
  state: DesktopAppState,
  patch: DesktopStatePatch,
): DesktopAppState {
  const result: Record<string, unknown> = { ...(state as unknown as Json), ...patch.set };
  for (const [key, entries] of Object.entries(patch.maps)) {
    const map: Record<string, unknown> = { ...((result[key] as Json | undefined) ?? {}) };
    Object.assign(map, entries.set);
    for (const entryKey of entries.del) delete map[entryKey];
    result[key] = map;
  }
  if (patch.workspaces) result.workspaces = applyWorkspaces(state.workspaces, patch.workspaces);
  result.revision = patch.revision;
  return result as unknown as DesktopAppState;
}

/** Whether `patch` applies on `state`, or the client must pull a full state. */
export function patchFits(state: DesktopAppState | null, patch: DesktopStatePatch): boolean {
  return patch.version === 1 && state !== null && state.revision === patch.baseRevision;
}

/** What a window receives on its state channel: the first state in full, then patches. */
export type DesktopStateUpdate = DesktopAppState | DesktopStatePatch;

export function isDesktopStatePatch(update: DesktopStateUpdate): update is DesktopStatePatch {
  return "baseRevision" in update && "sequence" in update;
}

/**
 * `next` with every workspace, session and top-level value that equals the one in `previous`
 * replaced by the old object. A full state (first load, resync, an action reply) would otherwise
 * hand every row a new object and re-render the whole sidebar.
 */
export function shareIdentity(previous: DesktopAppState | null, next: DesktopAppState): DesktopAppState {
  if (!previous || previous === next) return next;
  const before = previous as unknown as Json;
  const result: Record<string, unknown> = { ...(next as unknown as Json) };
  for (const key of Object.keys(result)) {
    if (key !== "workspaces" && valueEqual(before[key], result[key])) result[key] = before[key];
  }
  const oldWorkspaces = new Map(previous.workspaces.map((workspace) => [workspace.id, workspace]));
  const workspaces = next.workspaces.map((workspace) => {
    const old = oldWorkspaces.get(workspace.id);
    if (!old) return workspace;
    const oldSessions = new Map(old.sessions.map((session) => [session.id, session]));
    const sessions = workspace.sessions.map((session) => {
      const prior = oldSessions.get(session.id);
      return prior && valueEqual(prior, session) ? prior : session;
    });
    const sameSessions =
      sessions.length === old.sessions.length &&
      sessions.every((session, index) => session === old.sessions[index]);
    const merged = { ...workspace, sessions: sameSessions ? old.sessions : sessions };
    return valueEqual(withoutSessions(old), withoutSessions(workspace)) && sameSessions
      ? old
      : merged;
  });
  const sameList =
    workspaces.length === previous.workspaces.length &&
    workspaces.every((workspace, index) => workspace === previous.workspaces[index]);
  result.workspaces = sameList ? previous.workspaces : workspaces;
  return result as unknown as DesktopAppState;
}
