import { expect, test } from "@playwright/test";
import type { DesktopAppState, SessionRecord } from "../../contracts/desktop-state";
import { sessionsNeedingOwner } from "../../contracts/session-attention";
import { renderCountBadge } from "../../electron/platform/badge-icon";

function session(id: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    title: id,
    updatedAt: "2026-11-09T10:00:00.000Z",
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    ...patch,
  };
}

function state(
  sessions: readonly SessionRecord[],
  dialogs: readonly string[] = [],
): Pick<DesktopAppState, "workspaces" | "sessionExtensionUiBySession"> {
  return {
    workspaces: [{ id: "w", sessions }] as unknown as DesktopAppState["workspaces"],
    sessionExtensionUiBySession: Object.fromEntries(
      dialogs.map((id) => [`w:${id}`, { pendingDialogs: [{}] }]),
    ) as unknown as DesktopAppState["sessionExtensionUiBySession"],
  };
}

test("a chat needs the owner for a waiting dialog or an unseen failure", () => {
  const waiting = sessionsNeedingOwner(
    state(
      [
        session("dialog"),
        session("failed-unseen", { status: "failed", hasUnseenUpdate: true }),
        session("failed-seen", { status: "failed" }),
        session("done-unseen", { hasUnseenUpdate: true }),
        session("running"),
        session("archived", { status: "failed", hasUnseenUpdate: true, archivedAt: "x" }),
      ],
      ["dialog", "archived"],
    ),
  );
  expect(waiting.map((entry) => entry.key)).toEqual(["w:dialog", "w:failed-unseen"]);
  expect(waiting[0]).toEqual({ workspaceId: "w", sessionId: "dialog", key: "w:dialog" });
});

test("count badge is a 32px BGRA disc with white digits and caps at 9+", () => {
  for (const count of [1, 7, 12]) {
    const { bitmap, size } = renderCountBadge(count);
    expect(size).toBe(32);
    expect(bitmap.length).toBe(32 * 32 * 4);
    const center = (16 * 32 + 16) * 4;
    expect([...bitmap.subarray(0, 4)]).toEqual([0, 0, 0, 0]); // corner stays transparent
    const whitePixels = Array.from({ length: 32 * 32 }, (_, i) => i).filter(
      (i) => bitmap[i * 4] === 0xff && bitmap[i * 4 + 3] === 0xff,
    ).length;
    expect(whitePixels).toBeGreaterThan(20);
    expect(bitmap[center + 3]).toBe(0xff);
  }
  expect(renderCountBadge(12).bitmap.equals(renderCountBadge(9001).bitmap)).toBe(true);
});
