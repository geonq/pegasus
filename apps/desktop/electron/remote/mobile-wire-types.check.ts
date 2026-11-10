/**
 * Compile-time guard: the iPhone app (apps/mobile/src/api/types.ts) declares the part of these wire
 * types it reads. If a desktop change stops the real types fitting the phone's view, this file fails
 * `pnpm typecheck` here, instead of the phone breaking at run time. Nothing in it runs.
 */
import type * as Mobile from "../../../mobile/src/api/types";
import type {
  DesktopAppState,
  SelectedTranscriptRecord,
  SessionRecord,
  WorkspaceRecord,
} from "../../contracts/desktop-state";
import type { RemoteDesktopEvent } from "./remote-desktop-protocol";

type Assignable<From, To> = [From] extends [To] ? true : never;

export const mobileWireTypesFit: [
  Assignable<SessionRecord, Mobile.SessionRecord>,
  Assignable<WorkspaceRecord, Mobile.WorkspaceRecord>,
  Assignable<DesktopAppState, Mobile.DesktopAppState>,
  Assignable<SelectedTranscriptRecord, Mobile.SelectedTranscript>,
  Assignable<RemoteDesktopEvent, Mobile.RemoteEvent>,
] = [true, true, true, true, true];
