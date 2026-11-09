export const NEW_THREAD_PLACEHOLDER_TITLE = "New thread";

/**
 * A readable title from a prompt's first sentence: HTML comments, role tags such as
 * "[PI_CHILD_ROLE=planner]", markdown punctuation and links are dropped, and long text is cut
 * at a word boundary. Used for subagent chats and whenever a model-generated title is unavailable.
 */
export function promptTitle(prompt: string, limit = 48): string {
  // Paragraph by paragraph: a task without a full stop must not run into the next one.
  const paragraphs = prompt
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/\[[A-Z][A-Z0-9_]*=[^\]\s]*\]/g, " ")
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[`*_#>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const sentences = paragraphs.map((text) => text.split(/(?<=[.!?])\s+/));
  // Role lines ("You are a Seher worker.") say nothing about the task: take the first sentence that is not one.
  const sentence =
    sentences.map((list) => list.find((entry) => !isPreamble(entry))).find(Boolean) ??
    sentences[0]?.[0] ??
    "";
  const title = sentence.replace(/[.!?:;,]+$/, "").trim();
  if (!title) return NEW_THREAD_PLACEHOLDER_TITLE;
  if (title.length <= limit) return title.charAt(0).toUpperCase() + title.slice(1);
  const cut = title.slice(0, limit - 1);
  const wordEnd = cut.lastIndexOf(" ");
  const short = (wordEnd > limit / 2 ? cut.slice(0, wordEnd) : cut).replace(/[,;:-]+$/, "");
  return `${short.charAt(0).toUpperCase()}${short.slice(1)}…`;
}

/** A leading role line such as "You are a Seher worker." or "Act as the reviewer.". */
export function isPreamble(sentence: string): boolean {
  return /^(you are|you're|act as|your role)\b/i.test(sentence.trim());
}
