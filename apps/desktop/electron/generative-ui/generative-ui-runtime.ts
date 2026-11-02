import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { sessionKey, type SessionRef } from "@pi-gui/session-driver";
import {
  askUserToolName,
  describeGenerativeUiAnswer,
  inputs,
  parseGenerativeUi,
  parseGenerativeUiAnswer,
  showUiToolName,
  type GenerativeUiAnswer,
  type GenerativeUiSpec,
} from "../../contracts/generative-ui";

interface PendingQuestion {
  readonly session: string;
  readonly spec: GenerativeUiSpec;
  readonly resolve: (answer: GenerativeUiAnswer) => void;
}

/**
 * The ask_user calls waiting for the person, by tool call id. A call ends once: answered, or
 * rejected when its run is stopped. After a restart nothing is waiting, so an old question can
 * only be answered in the chat.
 */
export class GenerativeUiQuestions {
  private readonly pending = new Map<string, PendingQuestion>();

  ask(
    sessionRef: SessionRef,
    callId: string,
    spec: GenerativeUiSpec,
    signal: AbortSignal | undefined,
  ): Promise<GenerativeUiAnswer> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("The question was cancelled before it was answered."));
        return;
      }
      const onAbort = () => {
        this.pending.delete(callId);
        reject(new Error("The question was cancelled before it was answered."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(callId, {
        session: sessionKey(sessionRef),
        spec,
        resolve: (answer) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
      });
    });
  }

  /** Checks the answer against the question it answers, then lets the agent continue. */
  answer(sessionRef: SessionRef, callId: string, value: unknown): void {
    const question = this.pending.get(callId);
    if (!question || question.session !== sessionKey(sessionRef)) {
      throw new Error("This question is no longer waiting for an answer. Reply in the chat instead.");
    }
    const answer = parseGenerativeUiAnswer(question.spec, value);
    this.pending.delete(callId);
    question.resolve(answer);
  }

  isWaiting(callId: string): boolean {
    return this.pending.has(callId);
  }
}

const SPEC_PARAMETER = {
  type: "object",
  description:
    'The interface as JSON: {"title"?: string, "blocks": [block, ...]}. Blocks: ' +
    '{"type":"text","text"} · {"type":"card","title","subtitle"?,"text"?,"children"?:[block]} · ' +
    '{"type":"checklist","title"?,"items":[{"label","status":"pending|running|done|failed","note"?,"threadId"?}]} · ' +
    '{"type":"choice","id","label","options":[{"id","label","description"?}],"multiple"?,"allowOther"?} · ' +
    '{"type":"form","fields":[{"kind":"text|select|toggle","id","label","options"?,"placeholder"?,"multiline"?,"required"?}]} · ' +
    '{"type":"table","columns":[string],"rows":[[string]]} · {"type":"progress","label","value":0..1} · ' +
    '{"type":"callout","tone":"info|success|warning|error","text"} · {"type":"code","code","language"?} · ' +
    '{"type":"diagram","title"?,"mermaid"?: string} or {"type":"diagram","title"?,"nodes":[{"id","label","kind"?,"group"?,"description"?,"path"?}],"edges":[{"from","to","label"?}]} · ' +
    '{"type":"agent_map","title"?,"agents":[{"id","label","status","threadId"?,"role"?,"note"?,"parent"?}]}. ' +
    "All values are plain text; no HTML or markdown.",
};

export interface GenerativeUiRuntimeOptions {
  readonly questions: () => GenerativeUiQuestions;
  readonly sessionRef: (ctx: ExtensionContext) => SessionRef;
}

function showUiTool(): ToolDefinition<any, unknown> {
  return {
    name: showUiToolName,
    label: "Show UI",
    description:
      "Show the user a small interface in the chat: a to-do checklist, a table, a progress bar, a callout, a diagram or an agent map. Display only; use ask_user to get an answer.",
    promptSnippet:
      "show_ui: draw a checklist, table, diagram, progress or agent map in the chat (display only).",
    promptGuidelines: [
      "Use show_ui for a plan or to-do list you will work through, a table of results, or an architecture diagram. Prefer plain text for short answers.",
      "Pass the same key again to update a shown element in place, such as ticking off checklist items as you finish them.",
      "For diagrams, prefer nodes and edges with a group per area and a path per file; use mermaid only for flows a graph cannot show.",
      "When you hand work to subagents, show the plan as a checklist or agent_map and put each subagent's thread id in threadId; the items then tick themselves off as the subagents finish.",
    ],
    parameters: {
      type: "object",
      properties: {
        spec: SPEC_PARAMETER,
        key: {
          type: "string",
          description: "Optional id; a later show_ui with the same key replaces this element.",
        },
      },
      required: ["spec"],
    },
    async execute(_toolCallId, params) {
      // An invalid spec throws, so the model gets the reason back as a tool error and can fix it.
      const spec = parseGenerativeUi((params as Record<string, unknown>)?.spec);
      return {
        content: [{ type: "text", text: `Shown${spec.title ? `: ${spec.title}` : ""}.` }],
        details: { shown: true },
      };
    },
  };
}

function askUserTool(options: GenerativeUiRuntimeOptions): ToolDefinition<any, unknown> {
  return {
    name: askUserToolName,
    label: "Ask user",
    description:
      "Ask the user with clickable options or a short form drawn in the chat, and wait for the answer. The result is what they picked.",
    promptSnippet:
      "ask_user: ask the user to pick between options or fill a short form, and wait for the answer.",
    promptGuidelines: [
      "Use ask_user when the user must choose between a few concrete options (approaches, plans to approve, which item to do next) instead of asking in prose.",
      "Give every option a short label and a one-line description of its trade-off. Set allowOther when none may fit.",
      "Ask one decision at a time. Do not use ask_user for open questions a sentence answers better.",
    ],
    parameters: {
      type: "object",
      properties: { spec: SPEC_PARAMETER },
      required: ["spec"],
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const spec = parseGenerativeUi((params as Record<string, unknown>)?.spec);
      if (inputs(spec.blocks).length === 0) {
        throw new Error("ask_user needs at least one choice or form block; use show_ui to only show.");
      }
      const answer = await options
        .questions()
        .ask(options.sessionRef(ctx), toolCallId, spec, signal);
      return {
        content: [{ type: "text", text: describeGenerativeUiAnswer(spec, answer) }],
        details: { answer },
      };
    },
  };
}

export function createGenerativeUiRuntimeExtension(options: GenerativeUiRuntimeOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool(showUiTool());
    pi.registerTool(askUserTool(options));
  };
}
