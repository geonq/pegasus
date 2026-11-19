import type { RuntimeExtensionRecord } from "@pi-gui/session-driver/runtime-types";
import type {
  ExtensionCommandCompatibilityRecord,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import { ExtensionIcon } from "../../ui/icons";
import { SettingsGroup, SettingsRow } from "../settings/settings-utils";
import {
  extensionGroupLabel,
  isPiAddonExtension,
  isPiGuiBuiltinExtension,
  PI_ADDONS_LABEL,
  PI_GUI_TOOLS_LABEL,
  SCOPE_GROUP_ORDER,
} from "./extension-display";
import { findPlacement, PlacementControl, type ScopeContext } from "./placement-control";
import { displayPath, ResourceDetail } from "./resource-detail";
import { ResourceEmptyState, ResourceList, type ResourceListGroup } from "./resource-list";

const GROUP_ORDER = [...SCOPE_GROUP_ORDER, PI_ADDONS_LABEL, PI_GUI_TOOLS_LABEL];

interface ExtensionsTabProps {
  /** The open project, or undefined on the Global view. */
  readonly workspace?: WorkspaceRecord;
  readonly scope: ScopeContext;
  readonly extensions: readonly RuntimeExtensionRecord[];
  readonly commandCompatibility: readonly ExtensionCommandCompatibilityRecord[];
  readonly searching: boolean;
  /** The extension whose detail page is open, looked up in the unfiltered list. */
  readonly selected?: RuntimeExtensionRecord;
  readonly onSelect: (path: string | undefined) => void;
  readonly onToggleExtension: (path: string, enabled: boolean) => void;
  readonly onOpenExtensionFolder: (path: string) => void;
}

export function ExtensionsTab({
  workspace,
  scope,
  extensions,
  commandCompatibility,
  searching,
  selected,
  onSelect,
  onToggleExtension,
  onOpenExtensionFolder,
}: ExtensionsTabProps) {
  // A global extension's switch on a project page turns it on or off for that project only.
  const toggle = (path: string, enabled: boolean) =>
    !scope.globalView && findPlacement(scope, "extension", path)
      ? scope.onSetProjectEnabled("extension", path, enabled)
      : scope.globalView && findPlacement(scope, "extension", path)
        ? scope.onSetPlacement("extension", path, enabled, [])
        : onToggleExtension(path, enabled);
  // The list stays mounted under an open detail so expanded groups, scroll and focus survive.
  const list =
    extensions.length === 0 ? (
      <ResourceEmptyState
        title={searching ? "No extensions match" : "No extensions yet"}
        body={
          searching
            ? "Try another name, command or tool."
            : scope.globalView
              ? "Global extensions come from your extensions folder and load in every project. Refresh after adding one."
              : "This project has no extensions of its own. Add one to its .pi/extensions, or refresh after adding one."
        }
      />
    ) : (
      <ResourceList
        expanded={searching}
        groups={groupExtensions(extensions, scope, toggle)}
        icon={<ExtensionIcon />}
        testId="extensions-list"
        onOpen={onSelect}
      />
    );

  return (
    <>
      {selected ? (
        <ExtensionDetail
          commandCompatibility={commandCompatibility}
          scope={scope}
          selected={selected}
          workspace={workspace}
          onOpenExtensionFolder={onOpenExtensionFolder}
          onSelect={onSelect}
          onToggleExtension={toggle}
        />
      ) : null}
      <div hidden={Boolean(selected)}>{list}</div>
    </>
  );
}

function ExtensionDetail({
  selected,
  workspace,
  scope,
  commandCompatibility,
  onSelect,
  onToggleExtension,
  onOpenExtensionFolder,
}: Omit<ExtensionsTabProps, "extensions" | "searching" | "selected"> & {
  readonly selected: RuntimeExtensionRecord;
}) {
  const hasFolder = isFolderExtension(selected);
  const placement = findPlacement(scope, "extension", selected.path);
  const compatibilityRecords = commandCompatibility
    .filter((record) => record.extensionPath === selected.path)
    .sort((left, right) => left.commandName.localeCompare(right.commandName));
  return (
    <ResourceDetail
      actions={
        hasFolder ? (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => onOpenExtensionFolder(selected.path)}
          >
            Open folder
          </button>
        ) : null
      }
      backLabel="All extensions"
      enabled={scope.globalView && placement ? placement.global : selected.enabled}
      icon={<ExtensionIcon />}
      subtitle={selected.sourceInfo.source}
      title={selected.displayName}
      onBack={() => onSelect(undefined)}
      onToggle={
        isToggleableExtension(selected)
          ? (enabled) => onToggleExtension(selected.path, enabled)
          : undefined
      }
    >
      {selected.description ? (
        <p className="resource-detail__description">{selected.description}</p>
      ) : null}
      <SettingsGroup>
        {placement ? <PlacementControl placement={placement} scope={scope} /> : null}
        <SettingsRow
          title="Source"
          description={
            isPiAddonExtension(selected)
              ? "Ships with pi; this switch also applies to pi in the terminal"
              : selected.sourceInfo.origin === "package"
                ? "Installed as a package"
                : "Loaded from a file"
          }
        >
          <span className="settings-row__value">
            {extensionGroupLabel(selected, scope.globalView, Boolean(placement))}
          </span>
        </SettingsRow>
        {isPiGuiBuiltinExtension(selected) || isPiAddonExtension(selected) ? null : (
          <SettingsRow title="Location">
            <code className="resource-detail__code" title={selected.path}>
              {workspace ? displayPath(selected.path, workspace.path) : selected.path}
            </code>
          </SettingsRow>
        )}
      </SettingsGroup>
      <ExtensionContributionSection title="Tools" items={selected.tools.map((tool) => tool.name)} />
      {selected.commands.length > 0 ? (
        <ExtensionCompatibilitySection
          commands={selected.commands}
          compatibilityRecords={compatibilityRecords}
        />
      ) : null}
      <ExtensionContributionSection title="Flags" items={selected.flags} />
      <ExtensionContributionSection title="Shortcuts" items={selected.shortcuts} />
      <ExtensionDiagnostics diagnostics={selected.diagnostics} />
    </ResourceDetail>
  );
}

function groupExtensions(
  extensions: readonly RuntimeExtensionRecord[],
  scope: ScopeContext,
  onToggleExtension: (path: string, enabled: boolean) => void,
): readonly ResourceListGroup[] {
  const nameOf = (id: string) => scope.projects.find((project) => project.id === id)?.name ?? id;
  const labelOf = (extension: RuntimeExtensionRecord) =>
    extensionGroupLabel(
      extension,
      scope.globalView,
      Boolean(findPlacement(scope, "extension", extension.path)),
    );
  return GROUP_ORDER.map((label) => ({
    label,
    items: extensions
      .filter((extension) => labelOf(extension) === label)
      .map((extension) => {
        const placement = findPlacement(scope, "extension", extension.path);
        const onlyIn =
          scope.globalView && placement && !placement.global && placement.enabledIn.length > 0
            ? `Only in ${placement.enabledIn.map(nameOf).join(", ")}`
            : undefined;
        return {
          id: extension.path,
          title: extension.displayName,
          description: describeExtension(extension),
          ...(onlyIn ? { badge: onlyIn } : {}),
          enabled: scope.globalView && placement ? placement.global : extension.enabled,
          onToggle: isToggleableExtension(extension)
            ? (enabled: boolean) => onToggleExtension(extension.path, enabled)
            : undefined,
        };
      }),
  })).filter((group) => group.items.length > 0);
}

/** One line for the list: the extension's own description, else what it contributes. */
function describeExtension(extension: RuntimeExtensionRecord): string {
  if (extension.description) return extension.description;
  const parts = [
    countLabel(extension.tools.length, "tool"),
    countLabel(extension.commands.length, "command"),
    countLabel(extension.diagnostics.length, "issue"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : extension.sourceInfo.source;
}

function countLabel(count: number, noun: string): string {
  return count === 0 ? "" : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isFolderExtension(extension: RuntimeExtensionRecord): boolean {
  return (
    !isPiAddonExtension(extension) &&
    (extension.sourceInfo.scope === "project" || extension.sourceInfo.scope === "user")
  );
}

function isToggleableExtension(extension: RuntimeExtensionRecord): boolean {
  return (
    isFolderExtension(extension) ||
    isPiAddonExtension(extension) ||
    isPiGuiBuiltinExtension(extension)
  );
}

function ExtensionContributionSection({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <SettingsGroup title={title}>
      <div className="resource-detail__tokens">
        {items.map((item) => (
          <code className="resource-detail__token" key={item}>
            {item}
          </code>
        ))}
      </div>
    </SettingsGroup>
  );
}

function ExtensionDiagnostics({
  diagnostics,
}: {
  readonly diagnostics: RuntimeExtensionRecord["diagnostics"];
}) {
  if (diagnostics.length === 0) return null;
  return (
    <SettingsGroup title="Diagnostics">
      {diagnostics.map((diagnostic, index) => (
        <div
          className={`activity-item activity-item--${diagnostic.type === "error" ? "error" : "info"}`}
          key={`${diagnostic.message}:${index}`}
        >
          <div className="activity-item__text">{diagnostic.message}</div>
          {diagnostic.path ? <div className="activity-item__meta">{diagnostic.path}</div> : null}
        </div>
      ))}
    </SettingsGroup>
  );
}

function ExtensionCompatibilitySection({
  commands,
  compatibilityRecords,
}: {
  readonly commands: readonly string[];
  readonly compatibilityRecords: readonly ExtensionCommandCompatibilityRecord[];
}) {
  const supported = compatibilityRecords.filter((record) => record.status === "supported");
  const terminalOnly = compatibilityRecords.filter((record) => record.status === "terminal-only");
  const unknown = commands.filter((commandName) =>
    compatibilityRecords.every(
      (record) =>
        record.commandName !== commandName && !record.commandName.startsWith(`${commandName}:`),
    ),
  );

  return (
    <SettingsGroup
      title="Commands"
      description="Whether each command works in the app is learned the first time it runs here."
    >
      <div className="resource-detail__tokens">
        {supported.map((record) => (
          <code className="resource-detail__token" key={`supported:${record.commandName}`}>
            {record.commandName} · GUI-compatible
          </code>
        ))}
        {terminalOnly.map((record) => (
          <code
            className="resource-detail__token resource-detail__token--warning"
            key={`terminal:${record.commandName}`}
          >
            {record.commandName} · Terminal-only
          </code>
        ))}
        {unknown.map((commandName) => (
          <code className="resource-detail__token" key={`unknown:${commandName}`}>
            {commandName} · Unknown
          </code>
        ))}
      </div>
    </SettingsGroup>
  );
}
