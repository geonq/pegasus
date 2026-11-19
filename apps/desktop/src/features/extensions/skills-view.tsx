import type { RuntimeSkillRecord } from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import { titleCase } from "../../lib/string-utils";
import { SkillIcon } from "../../ui/icons";
import { SettingsGroup, SettingsRow } from "../settings/settings-utils";
import {
  GLOBAL_LABEL,
  projectGroupLabel,
  SCOPE_GROUP_ORDER,
  sourceScopeGroupLabel,
} from "./extension-display";
import { findPlacement, PlacementControl, type ScopeContext } from "./placement-control";
import { displayPath, ResourceDetail } from "./resource-detail";
import { ResourceEmptyState, ResourceList, type ResourceListGroup } from "./resource-list";

interface SkillsTabProps {
  /** The open project, or undefined on the Global view. */
  readonly workspace?: WorkspaceRecord;
  readonly scope: ScopeContext;
  readonly skills: readonly RuntimeSkillRecord[];
  readonly searching: boolean;
  /** The skill whose detail page is open, looked up in the unfiltered list. */
  readonly selected?: RuntimeSkillRecord;
  readonly onSelect: (filePath: string | undefined) => void;
  readonly onToggleSkill: (filePath: string, enabled: boolean) => void;
  readonly onOpenSkillFolder: (filePath: string) => void;
  readonly onTrySkill: (skill: RuntimeSkillRecord) => void;
}

export function SkillsTab({
  workspace,
  scope,
  skills,
  searching,
  selected,
  onSelect,
  onToggleSkill,
  onOpenSkillFolder,
  onTrySkill,
}: SkillsTabProps) {
  // A global skill's switch on a project page turns it on or off for that project only.
  const toggle = (skill: RuntimeSkillRecord, enabled: boolean) =>
    !scope.globalView && findPlacement(scope, "skill", skill.filePath)
      ? scope.onSetProjectEnabled("skill", skill.filePath, enabled)
      : onToggleSkill(skill.filePath, enabled);
  // The list stays mounted under an open detail so expanded groups, scroll and focus survive.
  const list =
    skills.length === 0 ? (
      <ResourceEmptyState
        title={searching ? "No skills match" : "No skills yet"}
        body={
          searching
            ? "Try another name, description or slash command."
            : scope.globalView
              ? "Global skills come from your skills folders and load in every project. Create one, or refresh after adding one."
              : "This project has no skills of its own and turns every global one off. Add one to its .pi/skills, or turn a global one back on."
        }
      />
    ) : (
      <ResourceList
        expanded={searching}
        groups={groupSkills(skills, scope, toggle)}
        icon={<SkillIcon />}
        testId="skills-list"
        onOpen={onSelect}
      />
    );
  const placement = selected ? findPlacement(scope, "skill", selected.filePath) : undefined;

  return (
    <>
      {selected ? (
        <ResourceDetail
          actions={
            <>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => onOpenSkillFolder(selected.filePath)}
              >
                Open folder
              </button>
              {workspace ? (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => onTrySkill(selected)}
                >
                  Try
                </button>
              ) : null}
            </>
          }
          backLabel="All skills"
          enabled={selected.enabled}
          icon={<SkillIcon />}
          subtitle={selected.slashCommand}
          title={titleCase(selected.name)}
          onBack={() => onSelect(undefined)}
          onToggle={(enabled) => toggle(selected, enabled)}
        >
          <p className="resource-detail__description">{selected.description}</p>
          <SettingsGroup>
            {placement ? <PlacementControl placement={placement} scope={scope} /> : null}
            <SettingsRow
              title="Slash command"
              description="Type it in the composer to run the skill."
            >
              <code className="resource-detail__code">{selected.slashCommand}</code>
            </SettingsRow>
            <SettingsRow
              title="Model invocation"
              description={
                selected.disableModelInvocation
                  ? "Only runs when you type its slash command."
                  : "pi can also choose this skill on its own when it fits the task."
              }
            >
              <span className="settings-row__value">
                {selected.disableModelInvocation ? "Slash command only" : "Automatic"}
              </span>
            </SettingsRow>
            <SettingsRow
              title="Location"
              description={placement ? "Global" : sourceScopeGroupLabel(selected.scope)}
            >
              <code className="resource-detail__code" title={selected.filePath}>
                {workspace ? displayPath(selected.filePath, workspace.path) : selected.filePath}
              </code>
            </SettingsRow>
          </SettingsGroup>
        </ResourceDetail>
      ) : null}
      <div hidden={Boolean(selected)}>{list}</div>
    </>
  );
}

function groupSkills(
  skills: readonly RuntimeSkillRecord[],
  scope: ScopeContext,
  toggle: (skill: RuntimeSkillRecord, enabled: boolean) => void,
): readonly ResourceListGroup[] {
  const nameOf = (id: string) => scope.projects.find((project) => project.id === id)?.name ?? id;
  const labelOf = (skill: RuntimeSkillRecord) =>
    scope.globalView
      ? GLOBAL_LABEL
      : projectGroupLabel(skill.scope, Boolean(findPlacement(scope, "skill", skill.filePath)));
  return SCOPE_GROUP_ORDER.map((label) => ({
    label,
    items: skills
      .filter((skill) => labelOf(skill) === label)
      .map((skill) => {
        const placement = findPlacement(scope, "skill", skill.filePath);
        const onlyIn =
          scope.globalView && placement && !placement.global && placement.enabledIn.length > 0
            ? `Only in ${placement.enabledIn.map(nameOf).join(", ")}`
            : undefined;
        return {
          id: skill.filePath,
          title: titleCase(skill.name),
          description: skill.description,
          ...(onlyIn ? { badge: onlyIn } : {}),
          enabled: scope.globalView && placement ? placement.global : skill.enabled,
          onToggle: (enabled: boolean) =>
            scope.globalView && placement
              ? scope.onSetPlacement("skill", skill.filePath, enabled, [])
              : toggle(skill, enabled),
        };
      }),
  })).filter((group) => group.items.length > 0);
}
