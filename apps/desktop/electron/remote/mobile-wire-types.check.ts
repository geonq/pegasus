/**
 * Compile-time guard: the iPhone app (apps/mobile/src/api/types.ts) declares the part of these wire
 * types it reads. If a desktop change stops the real types fitting the phone's view, this file fails
 * `pnpm typecheck` here, instead of the phone breaking at run time. Nothing in it runs.
 */
import type * as Mobile from "../../../mobile/src/api/types";
import type {
  DesktopAppState,
  OrchestrationChildThread,
  QueuedComposerMessage,
  SelectedTranscriptRecord,
  SessionExtensionDialogRecord,
  SessionRecord,
  WorkspaceRecord,
} from "../../contracts/desktop-state";
import type { AccountLimits, UsageLimitWindow } from "../../contracts/usage";
import type { SessionUsageSnapshot } from "@pi-gui/session-driver";
import type { RemoteDesktopEvent } from "./remote-desktop-protocol";

type Assignable<From, To> = [From] extends [To] ? true : never;

export const mobileWireTypesFit: [
  Assignable<SessionRecord, Mobile.SessionRecord>,
  Assignable<WorkspaceRecord, Mobile.WorkspaceRecord>,
  Assignable<DesktopAppState, Mobile.DesktopAppState>,
  Assignable<SelectedTranscriptRecord, Mobile.SelectedTranscript>,
  Assignable<RemoteDesktopEvent, Mobile.RemoteEvent>,
  // The records the phone answers, queues and reports from: each real desktop record must still fit
  // the phone's mirror, so renaming a field the phone reads fails here and not on the phone.
  Assignable<SessionExtensionDialogRecord, Mobile.PendingDialog>,
  Assignable<QueuedComposerMessage, Mobile.QueuedComposerMessage>,
  Assignable<SessionUsageSnapshot, Mobile.SessionUsageSnapshot>,
  Assignable<OrchestrationChildThread, Mobile.OrchestrationChildThread>,
  Assignable<AccountLimits, Mobile.AccountLimits>,
  Assignable<UsageLimitWindow, Mobile.AccountLimitWindow>,
] = [true, true, true, true, true, true, true, true, true, true, true];
