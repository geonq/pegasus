import { expect, test } from "@playwright/test";
import { promptTitle } from "../../electron/conversation/thread-title-constants";

test("prompt titles read like the task, without machine markup", () => {
  expect(
    promptTitle(
      "Audit preparation coverage for the Berlin hackathon. Read the event brief first.\n\n<!-- PI_NATIVE_CHILD role=planner task=x lease=y -->",
    ),
  ).toBe("Audit preparation coverage for the Berlin…");
  expect(promptTitle("[PI_CHILD_ROLE=reviewer]\nReview this change.")).toBe("Review this change");
  expect(
    promptTitle(
      "Reply with only the exact word: ok\n\nYou are assigned the reviewer role; Pi has activated it.",
    ),
  ).toBe("Reply with only the exact word: ok");
  expect(promptTitle("<!-- HERMES_NATIVE_CHILD role=planner task=a lease=b")).toBe("New thread");
  expect(promptTitle("fix the **login** bug in `auth.ts`")).toBe("Fix the login bug in auth.ts");
  expect(promptTitle("You are a Seher worker. Review the LifeOS goals page. Be brief.")).toBe(
    "Review the LifeOS goals page",
  );
  expect(promptTitle("You are a Seher worker.\n\nAct as the reviewer.\n\nFix the login bug.")).toBe(
    "Fix the login bug",
  );
  expect(promptTitle("You are a Seher worker.")).toBe("You are a Seher worker");
});
