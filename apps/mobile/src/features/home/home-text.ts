/** Text for the home rows, pure so node can test it. */

/** A chat title as one clean line: no markdown marks, backticks, links or line breaks. */
export function cleanTitle(raw: string): string {
  const text = raw
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*>]|\d+\.)\s+/gmu, "")
    .replace(/[`*_~]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text || "Untitled chat";
}

/** A preview as one clean line. */
export function cleanPreview(raw: string): string {
  const text = raw.replace(/\s+/gu, " ").trim();
  const clean = text === "" ? "" : cleanTitle(text);
  return clean === "Untitled chat" ? "" : clean;
}

/** "2 need you · 1 working", or null when calm. */
export function homeSummary(needs: number, working: number): string | null {
  const parts: string[] = [];
  if (needs > 0) parts.push(`${needs} ${needs === 1 ? "needs" : "need"} you`);
  if (working > 0) parts.push(`${working} working`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The address without its scheme, which tells the owner nothing. */
export function shortAddress(url: string): string {
  return url.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
}
