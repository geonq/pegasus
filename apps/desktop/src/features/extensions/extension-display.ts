import type {
  RuntimeExtensionRecord,
  RuntimeSourceScope,
} from "@pi-gui/session-driver/runtime-types";

export function extensionSourceSummary(extension: RuntimeExtensionRecord): string {
  return `${extensionScopeLabel(extension)} · ${extension.sourceInfo.origin}`;
}

export const PI_GUI_TOOLS_LABEL = "pi-gui tools";
export const PI_ADDONS_LABEL = "Built into pi";

/** Extensions pi-gui itself adds to every session; switched on and off app-wide. */
export function isPiGuiBuiltinExtension(extension: RuntimeExtensionRecord): boolean {
  return (
    extension.sourceInfo.source === "builtin" &&
    extension.sourceInfo.origin === "top-level" &&
    extension.sourceInfo.scope === "temporary"
  );
}

/**
 * pi's own add-ons (MCP, code mode, tool search), named `builtin:<name>`. Their switch writes
 * pi's `extensions` setting, so terminal pi follows it too.
 */
export function isPiAddonExtension(extension: RuntimeExtensionRecord): boolean {
  return extension.sourceInfo.source === "builtin" && extension.path.startsWith("builtin:");
}

export function extensionScopeLabel(extension: RuntimeExtensionRecord): string {
  if (isPiGuiBuiltinExtension(extension)) return PI_GUI_TOOLS_LABEL;
  if (isPiAddonExtension(extension)) return PI_ADDONS_LABEL;
  return extension.sourceInfo.scope;
}

export const PROJECT_ONLY_LABEL = "This project only";
export const GLOBAL_INHERITED_LABEL = "Global (inherited)";
export const GLOBAL_LABEL = "Global";

/** In a project: its own items, then the global ones it inherits, then one-session ones. */
export const SCOPE_GROUP_ORDER = [PROJECT_ONLY_LABEL, GLOBAL_INHERITED_LABEL, GLOBAL_LABEL, "This session"];

/** Group heading for where a skill or extension was discovered. */
export function sourceScopeGroupLabel(scope: RuntimeSourceScope): string {
  switch (scope) {
    case "project":
      return "Project";
    case "user":
      return "Global";
    case "temporary":
      return "This session";
  }
}

/**
 * Which group a project-view item belongs in. A global item a project turns on or off is still
 * the global item (`isGlobal`): pi reports it at project scope only because the project's
 * settings name it.
 */
export function projectGroupLabel(scope: RuntimeSourceScope, isGlobal: boolean): string {
  if (isGlobal) return GLOBAL_INHERITED_LABEL;
  if (scope === "project") return PROJECT_ONLY_LABEL;
  if (scope === "user") return GLOBAL_INHERITED_LABEL;
  return "This session";
}

export function extensionGroupLabel(
  extension: RuntimeExtensionRecord,
  globalView = false,
  isGlobal = false,
): string {
  if (isPiGuiBuiltinExtension(extension)) return PI_GUI_TOOLS_LABEL;
  if (isPiAddonExtension(extension)) return PI_ADDONS_LABEL;
  if (globalView) return GLOBAL_LABEL;
  return projectGroupLabel(extension.sourceInfo.scope, isGlobal);
}

/** "Every project", "Only in Uni", "Only in Uni and Notes", or "Off everywhere". */
export function placementSummary(
  placement: { readonly global: boolean; readonly enabledIn: readonly string[] } | undefined,
  projectName: (id: string) => string,
  projectCount: number,
): string {
  if (!placement) return "";
  if (placement.global && placement.enabledIn.length === projectCount) return "Every project";
  if (placement.enabledIn.length === 0) return placement.global ? "Every project" : "Off everywhere";
  const names = placement.enabledIn.map(projectName);
  const listed = names.length <= 2 ? names.join(" and ") : `${names.length} projects`;
  return placement.global ? `Every project except ${projectCount - names.length}` : `Only in ${listed}`;
}
