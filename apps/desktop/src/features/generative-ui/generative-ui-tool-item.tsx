import {
  answerFromToolOutput,
  askUserToolName,
  showUiToolName,
  specFromToolInput,
} from "../../../contracts/generative-ui";
import type { TimelineToolCall } from "../../../contracts/timeline-types";
import { GenerativeUiView, type QuestionState } from "./generative-ui-view";

/**
 * Whether a call is a show_ui or ask_user the app can draw. A spec the parser refused, or a
 * show_ui that failed, stays a plain tool row so its error shows.
 */
export function canDrawGenerativeUi(item: TimelineToolCall): boolean {
  return (
    (item.toolName === showUiToolName || item.toolName === askUserToolName) &&
    specFromToolInput(item.input) !== undefined &&
    !(item.toolName === showUiToolName && item.status === "error")
  );
}

/** A show_ui or ask_user call drawn as the interface it describes; see canDrawGenerativeUi. */
export function GenerativeUiToolItem({ item }: { readonly item: TimelineToolCall }) {
  const spec = specFromToolInput(item.input);
  if (!spec) return null;
  return <GenerativeUiView key={item.callId} spec={spec} state={questionState(item)} />;
}

function questionState(item: TimelineToolCall): QuestionState {
  if (item.toolName === showUiToolName) return { kind: "display" };
  const answer = answerFromToolOutput(item.output);
  if (answer) return { kind: "answered", answer };
  if (item.status === "running") return { kind: "open", callId: item.callId };
  // Stopped, failed or left waiting across a restart: the agent has moved on either way.
  return { kind: "closed", reason: "Not answered. Reply in the chat instead." };
}
