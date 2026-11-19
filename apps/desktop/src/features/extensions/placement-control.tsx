import type { RuntimeResourcePlacement } from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import { SettingsRow } from "../settings/settings-utils";
import { ReviewMenu } from "../workbench/review-menu";
import { placementSummary } from "./extension-display";

const EVERY_PROJECT = "__every-project__";

/** What the Skills and extensions page knows about global items and the projects they load in. */
export interface ScopeContext {
  /** True on the Global view; false when one project's view is open. */
  readonly globalView: boolean;
  readonly placements: readonly RuntimeResourcePlacement[];
  readonly projects: readonly WorkspaceRecord[];
  readonly onSetPlacement: (
    kind: RuntimeResourcePlacement["kind"],
    path: string,
    global: boolean,
    workspaceIds: readonly string[],
  ) => void;
  /** Turn a global item on or off in the open project only. */
  readonly onSetProjectEnabled: (
    kind: RuntimeResourcePlacement["kind"],
    path: string,
    enabled: boolean,
  ) => void;
}

export function findPlacement(
  scope: ScopeContext,
  kind: RuntimeResourcePlacement["kind"],
  path: string,
): RuntimeResourcePlacement | undefined {
  return scope.placements.find((entry) => entry.kind === kind && entry.path === path);
}

/**
 * "Where it loads" for one global skill or extension: every project, or a chosen set. Projects
 * are checkable and the menu stays open, so picking a second project keeps the first.
 */
export function PlacementControl({
  scope,
  placement,
}: {
  readonly scope: ScopeContext;
  readonly placement: RuntimeResourcePlacement;
}) {
  const { projects } = scope;
  const nameOf = (id: string) => projects.find((project) => project.id === id)?.name ?? id;
  const chosen = placement.global ? [] : placement.enabledIn;
  return (
    <SettingsRow
      title="Where it loads"
      description={
        placement.global
          ? "Every project. A project can still turn it off on its own page."
          : "Only the projects you pick, through each one's .pi/settings.json. Nothing is moved."
      }
    >
      <ReviewMenu
        align="end"
        buttonClassName="placement-control__button"
        buttonContent={<span aria-hidden="true">▾</span>}
        label="Where it loads"
        multiple
        options={[
          { id: EVERY_PROJECT, label: "Every project", checked: placement.global },
          ...projects.map((project, index) => ({
            id: project.id,
            label: project.name,
            checked: chosen.includes(project.id),
            startsGroup: index === 0,
          })),
        ]}
        popoverClassName="glass-popover"
        value={placementSummary(placement, nameOf, projects.length)}
        onSelect={(id) => {
          if (id === EVERY_PROJECT) {
            scope.onSetPlacement(placement.kind, placement.path, true, []);
            return;
          }
          const next = chosen.includes(id)
            ? chosen.filter((entry) => entry !== id)
            : [...chosen, id];
          // No project left means off everywhere.
          scope.onSetPlacement(placement.kind, placement.path, false, next);
        }}
      />
    </SettingsRow>
  );
}
