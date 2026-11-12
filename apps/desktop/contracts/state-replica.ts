import type { DesktopAppState } from "./desktop-state";
import {
  applyDesktopStatePatch,
  isDesktopStatePatch,
  shareIdentity,
  type DesktopStatePatch,
  type DesktopStateUpdate,
} from "./state-patch";

/**
 * A window's copy of the desktop state. Main sends one full state, then patches; the replica
 * applies each patch to the stream position it holds (`streamRevision`) and asks for a full state
 * when one does not fit (missed or reordered), instead of guessing.
 *
 * Actions return full states too (`adopt`): an adopted state is kept when it is newer, but it
 * never moves the stream position, because main diffs patches against what it last put on the
 * stream, not against what an action returned.
 */
export class DesktopStateReplica {
  state: DesktopAppState | null = null;
  private streamRevision: number | null = null;
  private resyncing = false;
  private buffered: DesktopStatePatch[] = [];

  /** Applies a pushed update. Returns "resync" when the caller must pull a full state now. */
  push(update: DesktopStateUpdate): "applied" | "resync" {
    if (!isDesktopStatePatch(update)) {
      this.takeFull(update);
      return "applied";
    }
    if (this.resyncing) {
      this.buffered.push(update);
      return "applied";
    }
    if (this.streamRevision === null || update.baseRevision !== this.streamRevision) {
      this.resyncing = true;
      this.buffered = [update];
      return "resync";
    }
    this.takePatch(update);
    return "applied";
  }

  /** A full state pulled at start or after a resync. Patches that arrived meanwhile apply after it. */
  pulled(full: DesktopAppState): "applied" | "resync" {
    this.takeFull(full);
    return this.drain();
  }

  /** A full state returned by an action: kept if newer, never moves the stream position. */
  adopt(full: DesktopAppState): void {
    if (!this.state || full.revision >= this.state.revision) {
      this.state = shareIdentity(this.state, full);
    }
  }

  private takeFull(full: DesktopAppState): void {
    this.state = shareIdentity(this.state, full);
    this.streamRevision = full.revision;
    this.resyncing = false;
  }

  private takePatch(patch: DesktopStatePatch): void {
    this.streamRevision = patch.revision;
    // An action reply may already be ahead of this patch; its content is in the state then.
    if (this.state && patch.revision > this.state.revision) {
      this.state = applyDesktopStatePatch(this.state, patch);
    }
  }

  private drain(): "applied" | "resync" {
    const pending = this.buffered.sort((a, b) => a.sequence - b.sequence);
    this.buffered = [];
    for (const patch of pending) {
      if (patch.baseRevision === this.streamRevision) this.takePatch(patch);
      else if (patch.baseRevision > (this.streamRevision ?? 0)) {
        this.resyncing = true;
        return "resync";
      }
    }
    return "applied";
  }
}
