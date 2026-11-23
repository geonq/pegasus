import type { ChatRow, HomeSection } from "../../api/chats.ts";

/** Palette keys a section icon may be tinted with. */
export type HeaderTint = "warning" | "success" | "accentText";

export type HomeItem =
  | {
      readonly kind: "header";
      readonly key: string;
      readonly title: string;
      /** SF Symbol before the title (status sections only). */
      readonly icon?: "exclamationmark.circle.fill" | "circle.dotted" | "pin.fill" | "folder";
      readonly tint?: HeaderTint;
      /** Chats in the section; 0 hides the number. */
      readonly count: number;
      /** Set on a project's header: the project its + starts a chat in. */
      readonly workspaceId?: string;
    }
  | {
      readonly kind: "chat";
      readonly key: string;
      readonly row: ChatRow;
      readonly showProject: boolean;
    }
  /** A project with no chats yet: one quiet row that starts one. */
  | {
      readonly kind: "placeholder";
      readonly key: string;
      readonly workspaceId: string;
      readonly projectName: string;
    };

/** Sections where chats of several projects mix, so each row names its project. */
const MIXED = new Set(["needs-you", "working", "pinned", "results"]);

const ICONS: Record<string, Pick<Extract<HomeItem, { kind: "header" }>, "icon" | "tint">> = {
  "needs-you": { icon: "exclamationmark.circle.fill", tint: "warning" },
  working: { icon: "circle.dotted", tint: "success" },
  pinned: { icon: "pin.fill" },
};

/**
 * The home sections as one flat list for LegendList: a header, then its rows, or a placeholder for
 * a project with no chats at all (one whose chats all sit in Needs you or Working shows its header
 * only).
 */
export function homeItems(sections: readonly HomeSection[]): HomeItem[] {
  const out: HomeItem[] = [];
  for (const section of sections) {
    const project = section.workspace;
    out.push({
      kind: "header",
      key: `h:${section.key}`,
      title: section.title,
      count: MIXED.has(section.key) ? section.rows.length : 0,
      ...(ICONS[section.key] ?? {}),
      ...(project ? { workspaceId: project.id } : {}),
    });
    if (project && section.noChats) {
      out.push({
        kind: "placeholder",
        key: `p:${project.id}`,
        workspaceId: project.id,
        projectName: project.name,
      });
      continue;
    }
    for (const row of section.rows) {
      out.push({
        kind: "chat",
        key: `${section.key}/${row.workspace.id}/${row.session.id}`,
        row,
        showProject: MIXED.has(section.key),
      });
    }
  }
  return out;
}
