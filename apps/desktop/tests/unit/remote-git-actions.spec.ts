import { expect, test } from "@playwright/test";
import { validateRemoteDesktopInvocation } from "../../electron/remote/remote-desktop-policy";
import { REMOTE_DESKTOP_PI_METHODS } from "../../electron/remote/remote-desktop-protocol";

const allowed = "D:\Pi\Alpha";
const scope = new Set([allowed]);

test("git actions and draft generation are remote methods with strict inputs", () => {
  for (const method of ["getGitActions", "draftGitText", "runGitAction", "sendReviewComments"])
    expect(REMOTE_DESKTOP_PI_METHODS).toContain(method);
  expect(validateRemoteDesktopInvocation("getGitActions", [{ reviewId: "r" }], scope).args).toEqual(
    [{ reviewId: "r" }],
  );
  expect(
    validateRemoteDesktopInvocation("draftGitText", [{ reviewId: "r", kind: "pr" }], scope).args,
  ).toEqual([{ reviewId: "r", kind: "pr" }]);
  expect(
    validateRemoteDesktopInvocation(
      "runGitAction",
      [{ reviewId: "r", action: "commit", title: " Fix it ", body: "why" }],
      scope,
    ).args,
  ).toEqual([{ reviewId: "r", action: "commit", title: "Fix it", body: "why" }]);
  for (const bad of [
    { reviewId: "r", action: "push", force: true },
    { reviewId: "r", action: "force-push" },
    { reviewId: "r", action: "commit", title: "  " },
    { reviewId: "r", action: "stage-all", title: "x" },
    { reviewId: "", action: "push" },
  ])
    expect(() => validateRemoteDesktopInvocation("runGitAction", [bad], scope)).toThrow();
  expect(() =>
    validateRemoteDesktopInvocation("draftGitText", [{ reviewId: "r", kind: "x" }], scope),
  ).toThrow();
  expect(() =>
    validateRemoteDesktopInvocation("getGitActions", [{ reviewId: "r" }, 1], scope),
  ).toThrow();
});

test("remote comment sends stay inside authorized workspaces", () => {
  const target = { workspaceId: allowed, sessionId: "s" };
  expect(
    validateRemoteDesktopInvocation("sendReviewComments", [{ target, text: "1. a.ts:1" }], scope)
      .args,
  ).toEqual([{ target, text: "1. a.ts:1" }]);
  expect(() =>
    validateRemoteDesktopInvocation(
      "sendReviewComments",
      [{ target: { workspaceId: "D:\Pi\Private", sessionId: "s" }, text: "x" }],
      scope,
    ),
  ).toThrow("not authorized");
  expect(() =>
    validateRemoteDesktopInvocation("sendReviewComments", [{ target, text: " " }], scope),
  ).toThrow();
  expect(() =>
    validateRemoteDesktopInvocation("sendReviewComments", [{ target, text: "x", extra: 1 }], scope),
  ).toThrow();
});
