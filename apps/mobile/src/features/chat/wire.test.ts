// Plain Node tests for the chat's wire helpers: node --test --experimental-strip-types
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptTool } from "../../api/types.ts";
import {
  attachmentProblem,
  buildAnswer,
  describeAnswer,
  permissionOf,
  questionState,
  specFromToolInput,
  thinkingOptionsFor,
  type ImageAttachment,
} from "./wire.ts";

const question = {
  title: "Pick an approach",
  blocks: [
    {
      type: "choice",
      id: "approach",
      label: "Approach",
      options: [
        { id: "small", label: "Smaller change" },
        { id: "big", label: "Rewrite" },
      ],
    },
    { type: "form", fields: [{ kind: "text", id: "why", label: "Why", required: true }] },
    {
      type: "diagram",
      nodes: [
        { id: "a", label: "App" },
        { id: "b", label: "Host" },
      ],
      edges: [{ from: "a", to: "b" }],
    },
    { type: "bogus" },
  ],
};

test("a spec keeps known blocks, flattens diagrams to lines and drops unknown ones", () => {
  const spec = specFromToolInput(question);
  assert.ok(spec);
  assert.deepEqual(
    spec.blocks.map((block) => block.type),
    ["choice", "form", "list"],
  );
  const list = spec.blocks[2];
  assert.ok(list && list.type === "list");
  assert.deepEqual(list.lines, ["App → Host"]);
  assert.equal(specFromToolInput({ spec: question })?.title, "Pick an approach");
  assert.equal(specFromToolInput({ blocks: "no" }), undefined);
});

test("an answer needs a pick and the required fields, like the PC checks", () => {
  const spec = specFromToolInput(question)!;
  assert.deepEqual(buildAnswer(spec, {}), { missing: 'Pick an option for "Approach".' });
  assert.deepEqual(buildAnswer(spec, { approach: "small", why: "  " }), {
    missing: 'Fill in "Why".',
  });
  const built = buildAnswer(spec, { approach: "small", why: "less risk" });
  assert.deepEqual(built, { answer: { approach: "small", why: "less risk" } });
  if (!("answer" in built)) throw new Error("expected an answer");
  assert.deepEqual(describeAnswer(spec, built.answer), [
    "Approach: Smaller change",
    "Why: less risk",
  ]);
});

test("an ask_user is open only while its run is live; an answer in the output wins", () => {
  const tool = {
    kind: "tool",
    id: "t",
    callId: "c1",
    toolName: "ask_user",
    status: "running",
    label: "Asked",
    createdAt: "t",
  } as TranscriptTool;
  assert.deepEqual(questionState(tool, true), { kind: "open", callId: "c1" });
  assert.deepEqual(questionState(tool, false), { kind: "closed" });
  const answered = {
    ...tool,
    status: "success",
    output: { details: { answer: { a: "b" } } },
  } as TranscriptTool;
  assert.deepEqual(questionState(answered, false), { kind: "answered", answer: { a: "b" } });
  assert.deepEqual(questionState({ ...tool, toolName: "show_ui" }, true), { kind: "display" });
});

test("permission comes from the pi-permission status; unknown text is null, none is undefined", () => {
  const state = (text?: string) =>
    ({
      sessionExtensionUiBySession: {
        "w:s": {
          pendingDialogs: [],
          ...(text === undefined ? {} : { statuses: [{ key: "pi-permission", text }] }),
        },
      },
    }) as never;
  assert.equal(permissionOf(state("edits"), "w:s"), "edits");
  assert.equal(permissionOf(state("weird"), "w:s"), null);
  assert.equal(permissionOf(state(), "w:s"), undefined);
});

test("effort options follow the model; photos stay under the PC's limits", () => {
  const model = {
    providerId: "p",
    providerName: "P",
    modelId: "m",
    label: "M",
    available: true,
    thinkingLevels: ["high", "low", "off"],
    supportsImages: true,
  };
  assert.deepEqual(thinkingOptionsFor(model), ["off", "low", "high"]);
  assert.equal(thinkingOptionsFor(undefined).length, 7);
  const photo = (bytes: number): ImageAttachment => ({
    id: String(bytes),
    kind: "image",
    name: "p.jpg",
    mimeType: "image/jpeg",
    data: "A".repeat(Math.ceil((bytes * 4) / 3)),
  });
  assert.equal(attachmentProblem([], photo(1_000)), null);
  assert.match(attachmentProblem([], photo(11 * 1024 * 1024)) ?? "", /10 MB/);
  assert.match(attachmentProblem([photo(9e6), photo(9e6)], photo(9e6)) ?? "", /20 MB/);
});
