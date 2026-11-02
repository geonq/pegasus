import { expect, test } from "@playwright/test";
import {
  describeGenerativeUiAnswer,
  parseGenerativeUi,
  parseGenerativeUiAnswer,
} from "../../contracts/generative-ui";
import { GenerativeUiQuestions } from "../../electron/generative-ui/generative-ui-runtime";
import { validateRemoteDesktopInvocation } from "../../electron/remote/remote-desktop-policy";
import { buildDisplayTimelineItems } from "../../src/features/conversation/timeline-turns";
import type { TranscriptMessage } from "../../contracts/timeline-types";

const question = {
  title: "Pick",
  blocks: [
    {
      type: "choice",
      id: "approach",
      label: "Approach",
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
    },
    {
      type: "form",
      fields: [
        { kind: "text", id: "why", label: "Why", required: true },
        { kind: "toggle", id: "now", label: "Start now" },
      ],
    },
  ],
};

test("a spec keeps only the catalog, as plain text, within its limits", () => {
  const spec = parseGenerativeUi({
    ...question,
    blocks: [
      ...question.blocks,
      { type: "iframe", src: "https://x" },
      { type: "text", text: "<b>hi</b>" },
    ],
  });
  expect(spec.blocks.map((block) => block.type)).toEqual(["choice", "form", "text"]);
  // Text is kept as text; the renderer never parses it as HTML.
  expect(spec.blocks[2]).toEqual({ type: "text", text: "<b>hi</b>" });
  expect(parseGenerativeUi(JSON.stringify(question)).title).toBe("Pick");
  const nested = {
    type: "card",
    title: "a",
    children: [{ type: "card", title: "b", children: [{ type: "card", title: "c" }] }],
  };
  for (const bad of [
    null,
    "not json",
    { blocks: [] },
    { blocks: [{ type: "iframe" }] },
    { blocks: [{ type: "choice", id: "x y", label: "L", options: [{ label: "o" }] }] },
    { blocks: [{ type: "choice", id: "__proto__", label: "L", options: [{ label: "o" }] }] },
    { blocks: [{ type: "choice", id: "c", label: "L", options: [] }] },
    { blocks: [{ type: "text", text: "x".repeat(5000) }] },
    { blocks: Array.from({ length: 41 }, () => ({ type: "text", text: "x" })) },
    { blocks: [nested] },
    {
      blocks: [
        { type: "choice", id: "same", label: "A", options: [{ label: "o" }] },
        { type: "form", fields: [{ kind: "text", id: "same", label: "B" }] },
      ],
    },
  ]) {
    expect(() => parseGenerativeUi(bad), JSON.stringify(bad)?.slice(0, 80)).toThrow();
  }
  // An edge to a node that is not drawn is dropped.
  const diagram = parseGenerativeUi({
    blocks: [
      { type: "diagram", nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "zz" }] },
    ],
  }).blocks[0];
  expect(diagram).toEqual({ type: "diagram", nodes: [{ id: "a", label: "A" }], edges: [] });
});

test("an answer must fit its question", () => {
  const spec = parseGenerativeUi(question);
  expect(parseGenerativeUiAnswer(spec, { approach: "a", why: " speed ", extra: "x" })).toEqual({
    approach: "a",
    why: "speed",
    now: false,
  });
  expect(() => parseGenerativeUiAnswer(spec, { approach: "zzz", why: "x" })).toThrow(
    "not an option",
  );
  expect(() => parseGenerativeUiAnswer(spec, { approach: ["a", "b"], why: "x" })).toThrow(
    "takes one",
  );
  expect(() => parseGenerativeUiAnswer(spec, { approach: "a" })).toThrow('Fill in "Why"');
  expect(() => parseGenerativeUiAnswer(spec, { why: "x" })).toThrow("Pick an option");
  expect(describeGenerativeUiAnswer(spec, { approach: "b", why: "w", now: true })).toContain(
    "Approach: Beta\nWhy: w\nStart now: yes",
  );
});

test("a question is answered once, by its own chat, and a stop cancels it", async () => {
  const questions = new GenerativeUiQuestions();
  const spec = parseGenerativeUi(question);
  const chat = { workspaceId: "w", sessionId: "s" };
  const pending = questions.ask(chat, "call-1", spec, undefined);
  expect(() => questions.answer({ workspaceId: "w", sessionId: "other" }, "call-1", {})).toThrow(
    "no longer waiting",
  );
  expect(() => questions.answer(chat, "call-1", { approach: "a" })).toThrow("Fill in");
  questions.answer(chat, "call-1", { approach: "a", why: "x" });
  await expect(pending).resolves.toEqual({ approach: "a", why: "x", now: false });
  expect(() => questions.answer(chat, "call-1", { approach: "a", why: "x" })).toThrow(
    "no longer",
  );

  const stop = new AbortController();
  const stopped = questions.ask(chat, "call-2", spec, stop.signal);
  stop.abort();
  await expect(stopped).rejects.toThrow("cancelled");
  expect(questions.isWaiting("call-2")).toBe(false);
});

test("the Mac client may answer only with plain values in an allowed chat", () => {
  const scope = new Set(["w"]);
  expect(
    validateRemoteDesktopInvocation(
      "answerGenerativeUi",
      ["w", "s", "c", { a: "x", b: ["y"], c: true }],
      scope,
    ),
  ).toEqual({ method: "answerGenerativeUi", args: ["w", "s", "c", { a: "x", b: ["y"], c: true }] });
  for (const args of [
    ["other", "s", "c", {}],
    ["w", "s", "c", { a: { nested: 1 } }],
    ["w", "s", "c", JSON.parse('{"__proto__": "x"}')],
    ["w", "s", "c"],
  ]) {
    expect(() => validateRemoteDesktopInvocation("answerGenerativeUi", args, scope)).toThrow();
  }
});

test("a keyed show_ui updates in place and a question left waiting expires", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 2, 12, 0, seconds)).toISOString();
  const tool = (
    id: string,
    toolName: string,
    input: unknown,
    status: "running" | "success",
  ): TranscriptMessage => ({
    kind: "tool",
    id,
    callId: id,
    toolName,
    status,
    label: id,
    input,
    createdAt: at(1),
  });
  const plan = (done: boolean) => ({
    key: "plan",
    spec: {
      blocks: [{ type: "checklist", items: [{ label: "a", status: done ? "done" : "pending" }] }],
    },
  });
  const transcript: TranscriptMessage[] = [
    { kind: "message", id: "u", role: "user", text: "go", createdAt: at(0) },
    tool("p1", "show_ui", plan(false), "success"),
    tool("x", "project_shell", { command: "ls" }, "success"),
    tool("p2", "show_ui", plan(true), "success"),
    tool("q", "ask_user", { spec: question }, "running"),
  ];
  const view = (running: boolean) =>
    buildDisplayTimelineItems(transcript, { lastTurnRunning: running }).filter(
      (item) => item.kind === "tool",
    );
  const live = view(true);
  expect(live.map((item) => item.id)).toEqual(["p1", "x", "q"]);
  expect(live[0]?.kind === "tool" && live[0].input).toEqual(plan(true));
  const after = view(false).find((item) => item.id === "q");
  expect(after?.kind === "tool" && [after.status, after.detail]).toEqual([
    "error",
    "Expired. Reply in the chat instead.",
  ]);
});
