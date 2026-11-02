import { createContext, useContext, useId, useState, type ReactNode } from "react";
import type { ExtensionAction } from "@pi-gui/session-driver";
import {
  inputs,
  parseGenerativeUiAnswer,
  type GenerativeUiAnswer,
  type GenerativeUiSpec,
  type UiField,
  type UiNode,
} from "../../../contracts/generative-ui";
import { DiagramView } from "./diagram-view";
import { AgentMapView } from "./agent-map-view";

/** What a drawn interface can ask of the app: answer its question, open a file, fill the composer. */
export interface GenerativeUiHost {
  readonly answer: (callId: string, answer: GenerativeUiAnswer) => Promise<void>;
  readonly runAction?: (action: ExtensionAction) => void;
  readonly openThread?: (threadId: string) => void;
  /** Keeps a diagram in the side panel while the chat goes on. */
  readonly pinDiagram?: (node: Extract<UiNode, { type: "diagram" }>) => void;
}

export const GenerativeUiContext = createContext<GenerativeUiHost | null>(null);

export function useGenerativeUiHost(): GenerativeUiHost | null {
  return useContext(GenerativeUiContext);
}

type Values = Record<string, string | string[] | boolean>;
const OTHER = "__other__";

export type QuestionState =
  | { readonly kind: "display" }
  | { readonly kind: "open"; readonly callId: string }
  | { readonly kind: "answered"; readonly answer: GenerativeUiAnswer }
  | { readonly kind: "closed"; readonly reason: string };

/**
 * One agent-described interface, drawn with the app's own components. An open question can be
 * answered once; an answered one shows what was picked; a closed one says why it cannot be.
 */
export function GenerativeUiView({
  spec,
  state,
}: {
  readonly spec: GenerativeUiSpec;
  readonly state: QuestionState;
}) {
  const host = useGenerativeUiHost();
  const answered = state.kind === "answered" ? state.answer : undefined;
  const [values, setValues] = useState<Values>(() => initialValues(spec, answered));
  const [other, setOther] = useState<Record<string, string>>(() => initialOther(spec, answered));
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const editable = state.kind === "open" && !sending && host !== null;
  const hasInputs = inputs(spec.blocks).length > 0;

  const submit = async () => {
    if (state.kind !== "open" || !host) return;
    let answer: GenerativeUiAnswer;
    try {
      answer = parseGenerativeUiAnswer(spec, withOther(values, other));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      return;
    }
    setError(undefined);
    setSending(true);
    try {
      await host.answer(state.callId, answer);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      setSending(false);
    }
  };

  const context: NodeContext = {
    values: answered ? initialValues(spec, answered) : values,
    other: answered ? initialOther(spec, answered) : other,
    editable,
    setValue: (inputId, value) => setValues((current) => ({ ...current, [inputId]: value })),
    setOther: (inputId, value) => setOther((current) => ({ ...current, [inputId]: value })),
  };

  return (
    <section
      className="generative-ui"
      data-testid="generative-ui"
      data-state={state.kind}
      aria-label={spec.title ?? "Interactive card"}
    >
      {spec.title ? <header className="generative-ui__title">{spec.title}</header> : null}
      <div className="generative-ui__blocks">
        {spec.blocks.map((block, index) => (
          <Node key={index} node={block} context={context} />
        ))}
      </div>
      {hasInputs ? (
        <footer className="generative-ui__footer">
          {state.kind === "open" ? (
            <button
              type="button"
              className="generative-ui__submit"
              disabled={!editable}
              onClick={() => void submit()}
              data-testid="generative-ui-submit"
            >
              {sending ? "Sending…" : "Send answer"}
            </button>
          ) : null}
          {state.kind === "answered" ? (
            <span className="generative-ui__status generative-ui__status--done">Answered</span>
          ) : null}
          {state.kind === "closed" ? (
            <span className="generative-ui__status">{state.reason}</span>
          ) : null}
          {error ? (
            <span className="generative-ui__error" role="alert">
              {error}
            </span>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

interface NodeContext {
  readonly values: Values;
  readonly other: Record<string, string>;
  readonly editable: boolean;
  readonly setValue: (inputId: string, value: string | string[] | boolean) => void;
  readonly setOther: (inputId: string, value: string) => void;
}

function Node({ node, context }: { readonly node: UiNode; readonly context: NodeContext }): ReactNode {
  switch (node.type) {
    case "text":
      return <p className="generative-ui__text">{node.text}</p>;
    case "card":
      return (
        <section className="generative-ui__card">
          <div className="generative-ui__card-title">{node.title}</div>
          {node.subtitle ? <div className="generative-ui__card-subtitle">{node.subtitle}</div> : null}
          {node.children.map((child, index) => (
            <Node key={index} node={child} context={context} />
          ))}
        </section>
      );
    case "checklist":
      return (
        <div className="generative-ui__checklist">
          {node.title ? <div className="generative-ui__label">{node.title}</div> : null}
          <ul>
            {node.items.map((item, index) => (
              <li key={index} className={`generative-ui__check generative-ui__check--${item.status}`} data-status={item.status}>
                <span className="generative-ui__check-mark" aria-label={item.status}>
                  {CHECK_MARKS[item.status]}
                </span>
                <span className="generative-ui__check-label">{item.label}</span>
                {item.note ? <span className="generative-ui__check-note">{item.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      );
    case "choice":
      return <Choice node={node} context={context} />;
    case "form":
      return (
        <div className="generative-ui__form">
          {node.fields.map((entry) => (
            <Field key={entry.id} field={entry} context={context} />
          ))}
        </div>
      );
    case "table":
      return (
        <div className="generative-ui__table-wrap">
          <table className="generative-ui__table">
            <thead>
              <tr>
                {node.columns.map((column, index) => (
                  <th key={index}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {node.columns.map((_, cellIndex) => (
                    <td key={cellIndex}>{row[cellIndex] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "progress":
      return (
        <div className="generative-ui__progress">
          <div className="generative-ui__label">
            {node.label} <span className="generative-ui__muted">{Math.round(node.value * 100)}%</span>
          </div>
          <div
            className="generative-ui__progress-track"
            role="progressbar"
            aria-label={node.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(node.value * 100)}
          >
            <div className="generative-ui__progress-bar" style={{ width: `${node.value * 100}%` }} />
          </div>
        </div>
      );
    case "callout":
      return (
        <div className={`generative-ui__callout generative-ui__callout--${node.tone}`} role="note">
          {node.text}
        </div>
      );
    case "code":
      return (
        <pre className="generative-ui__code" data-language={node.language}>
          <code>{node.code}</code>
        </pre>
      );
    case "diagram":
      return <DiagramView node={node} />;
    case "agent_map":
      return <AgentMapView node={node} />;
    default:
      return null;
  }
}

const CHECK_MARKS = { pending: "○", running: "◐", done: "✓", failed: "✕" } as const;

function Choice({
  node,
  context,
}: {
  readonly node: Extract<UiNode, { type: "choice" }>;
  readonly context: NodeContext;
}) {
  // Two questions in one chat may reuse a choice id; each radio group still needs its own name.
  const groupName = useId();
  const current = context.values[node.id];
  const picked = new Set(Array.isArray(current) ? current : typeof current === "string" ? [current] : []);
  const pick = (optionId: string) => {
    if (!node.multiple) {
      context.setValue(node.id, optionId);
      return;
    }
    const next = new Set(picked);
    if (next.has(optionId)) next.delete(optionId);
    else next.add(optionId);
    context.setValue(node.id, [...next]);
  };
  const options = node.allowOther
    ? [...node.options, { id: OTHER, label: "Other…" }]
    : node.options;
  return (
    <fieldset className="generative-ui__choice" disabled={!context.editable}>
      <legend className="generative-ui__label">{node.label}</legend>
      {options.map((option) => (
        <label
          key={option.id}
          className={`generative-ui__option ${picked.has(option.id) ? "generative-ui__option--picked" : ""}`}
        >
          <input
            type={node.multiple ? "checkbox" : "radio"}
            name={groupName}
            value={option.id}
            checked={picked.has(option.id)}
            onChange={() => pick(option.id)}
          />
          <span className="generative-ui__option-text">
            <span className="generative-ui__option-label">{option.label}</span>
            {"description" in option && option.description ? (
              <span className="generative-ui__option-description">{option.description}</span>
            ) : null}
          </span>
        </label>
      ))}
      {picked.has(OTHER) ? (
        <input
          className="generative-ui__input"
          aria-label={`${node.label}: other`}
          placeholder="Your answer"
          value={context.other[node.id] ?? ""}
          onChange={(event) => context.setOther(node.id, event.target.value)}
        />
      ) : null}
    </fieldset>
  );
}

function Field({ field, context }: { readonly field: UiField; readonly context: NodeContext }) {
  const value = context.values[field.id];
  if (field.kind === "toggle") {
    return (
      <label className="generative-ui__toggle">
        <input
          type="checkbox"
          checked={value === true}
          disabled={!context.editable}
          onChange={(event) => context.setValue(field.id, event.target.checked)}
        />
        {field.label}
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label className="generative-ui__field">
        <span className="generative-ui__label">{field.label}</span>
        <select
          className="generative-ui__input"
          value={typeof value === "string" ? value : ""}
          disabled={!context.editable}
          onChange={(event) => context.setValue(field.id, event.target.value)}
        >
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const shared = {
    className: "generative-ui__input",
    value: typeof value === "string" ? value : "",
    placeholder: field.placeholder,
    disabled: !context.editable,
    "aria-label": field.label,
  };
  return (
    <label className="generative-ui__field">
      <span className="generative-ui__label">{field.label}</span>
      {field.multiline ? (
        <textarea {...shared} rows={3} onChange={(event) => context.setValue(field.id, event.target.value)} />
      ) : (
        <input {...shared} onChange={(event) => context.setValue(field.id, event.target.value)} />
      )}
    </label>
  );
}

function initialValues(spec: GenerativeUiSpec, answer: GenerativeUiAnswer | undefined): Values {
  const values: Values = {};
  for (const input of inputs(spec.blocks)) {
    const given = answer?.[input.id];
    if (input.kind === "choice") {
      const known = new Set(input.node.options.map((option) => option.id));
      const list = Array.isArray(given) ? [...given] : typeof given === "string" ? [given] : [];
      // A free-text answer shows as the picked "Other…" with its text.
      const mapped = list.map((entry) => (known.has(entry) ? entry : OTHER));
      values[input.id] = input.node.multiple ? mapped : (mapped[0] ?? "");
    } else if (input.field.kind === "toggle") {
      values[input.id] = given === true;
    } else {
      values[input.id] = typeof given === "string" ? given : "";
    }
  }
  return values;
}

function initialOther(spec: GenerativeUiSpec, answer: GenerativeUiAnswer | undefined): Record<string, string> {
  const other: Record<string, string> = {};
  for (const input of inputs(spec.blocks)) {
    if (input.kind !== "choice") continue;
    const given = answer?.[input.id];
    const known = new Set(input.node.options.map((option) => option.id));
    const list = Array.isArray(given) ? given : typeof given === "string" ? [given] : [];
    const free = list.find((entry) => !known.has(entry));
    if (free) other[input.id] = free;
  }
  return other;
}

/** Replaces a picked "Other…" with the text typed for it. */
function withOther(values: Values, other: Record<string, string>): Values {
  const result: Values = {};
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      result[key] = value.flatMap((entry) =>
        entry === OTHER ? (other[key]?.trim() ? [other[key]!.trim()] : []) : [entry],
      );
    } else if (value === OTHER) {
      result[key] = other[key]?.trim() ?? "";
    } else {
      result[key] = value;
    }
  }
  return result;
}
