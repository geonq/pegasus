import { expect, test } from "@playwright/test";
import {
  caretAllowsHistory,
  chatPromptHistory,
  idleNavigation,
  recordPrompt,
  stepPromptHistory,
} from "../../src/features/conversation/prompt-history";

test("a chat's ArrowUp history is its own user prompts only, newest first", () => {
  const transcript = [
    { kind: "message", role: "user", text: "first in this chat" },
    { kind: "message", role: "assistant", text: "answer" },
    { kind: "tool", role: undefined, text: undefined },
    { kind: "message", role: "user", text: "second in this chat" },
    { kind: "message", role: "user", text: "second in this chat" },
  ];
  const own = chatPromptHistory(transcript);
  expect(own).toEqual(["second in this chat", "first in this chat"]);
  expect(stepPromptHistory(own, idleNavigation, "", "older")?.draft).toBe("second in this chat");
  expect(chatPromptHistory([])).toEqual([]);
});

test("prompt history recalls newest first and gives the draft back past the newest", () => {
  let history = recordPrompt([], "first");
  history = recordPrompt(history, "second");
  history = recordPrompt(history, "second");
  history = recordPrompt(history, "   ");
  expect(history).toEqual(["second", "first"]);

  const up1 = stepPromptHistory(history, idleNavigation, "half typed", "older")!;
  expect(up1.draft).toBe("second");
  const up2 = stepPromptHistory(history, up1.navigation, up1.draft, "older")!;
  expect(up2.draft).toBe("first");
  expect(stepPromptHistory(history, up2.navigation, up2.draft, "older")).toBeNull();

  const down1 = stepPromptHistory(history, up2.navigation, up2.draft, "newer")!;
  expect(down1.draft).toBe("second");
  const down2 = stepPromptHistory(history, down1.navigation, down1.draft, "newer")!;
  expect(down2).toEqual({ draft: "half typed", navigation: idleNavigation });
  expect(stepPromptHistory(history, down2.navigation, down2.draft, "newer")).toBeNull();
});

test("an edited recalled prompt becomes the live draft", () => {
  const history = ["second", "first"];
  const up = stepPromptHistory(history, idleNavigation, "", "older")!;
  const edited = stepPromptHistory(history, up.navigation, "second, but changed", "older")!;
  expect(edited.draft).toBe("second");
  const back = stepPromptHistory(history, edited.navigation, edited.draft, "newer")!;
  expect(back.draft).toBe("second, but changed");
});

test("history only takes the arrow keys at the first or last line", () => {
  const text = "line one\nline two";
  expect(caretAllowsHistory(text, 3, 3, "older")).toBe(true);
  expect(caretAllowsHistory(text, 12, 12, "older")).toBe(false);
  expect(caretAllowsHistory(text, 12, 12, "newer")).toBe(true);
  expect(caretAllowsHistory(text, 3, 3, "newer")).toBe(false);
  expect(caretAllowsHistory(text, 0, 4, "older")).toBe(false);
});
