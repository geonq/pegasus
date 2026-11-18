interface CatalogModel {
  readonly provider: string;
  readonly id: string;
}

/** Picker policy only: original model IDs/history and inference routes remain intact. */
export function currentDesktopModels<T extends CatalogModel>(models: readonly T[]): T[] {
  const claude = /^(?:anthropic(?:-account-[2-5])?|claude-code(?:-account-[1-5])?)$/;
  const openai = /^(?:openai(?:-account-[2-5])?|openai-codex)$/;
  const latest = new Map<string, { version: number; id: string }>();
  for (const model of models) {
    if (!claude.test(model.provider)) continue;
    const match = /^claude-(fable|haiku|opus|sonnet)-(\d+)(?:[-.](\d{1,3}))?(?:-(\d{8}))?$/.exec(
      model.id,
    );
    if (!match) continue;
    const key = `${model.provider}:${match[1]}`;
    const version = Number(match[2]) * 1000 + Number(match[3] ?? 0);
    const previous = latest.get(key);
    // Prefer an undated canonical alias over the same dated version.
    if (
      !previous ||
      version > previous.version ||
      (version === previous.version &&
        (previous.id.length > model.id.length ||
          (previous.id.length === model.id.length && previous.id < model.id)))
    ) {
      latest.set(key, { version, id: model.id });
    }
  }
  const claudeKeys = new Set(
    [...latest.entries()].map(
      ([key, model]) => `${key.slice(0, key.lastIndexOf(":"))}:${model.id}`,
    ),
  );
  return models.filter((model) =>
    claude.test(model.provider)
      ? claudeKeys.has(`${model.provider}:${model.id}`)
      : !openai.test(model.provider) || isCurrentOpenAiModel(model.id),
  );
}

/** Oldest GPT generation the picker still offers; everything the runtime knows from here on shows. */
const OPENAI_FLOOR = 5_006;

/**
 * A GPT model the picker shows: any `gpt-<major>[.<minor>]` at or above GPT-5.6, so a new family
 * (GPT-6.2, GPT-7, a new codename) appears as soon as the runtime's catalog has it, with no code
 * change. Anything else (gpt-4o, o-series, codex-auto-review) stays hidden.
 */
function isCurrentOpenAiModel(id: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d{1,3}))?(?:-|$)/.exec(id);
  if (!match) return false;
  return Number(match[1]) * 1000 + Number(match[2] ?? 0) >= OPENAI_FLOOR;
}
