export interface PlainError {
  /** One sentence the owner can act on. */
  readonly summary: string;
  /** The text as the provider sent it, for the disclosure. */
  readonly raw: string;
}

interface ErrorBody {
  readonly message?: string;
  readonly type?: string;
  readonly code?: string | number;
  readonly status?: string;
}

/** Pulls `{message,type,code}` out of OpenAI, Anthropic and Google error bodies. */
function readBody(text: string): ErrorBody | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    if (!parsed || typeof parsed !== "object") return undefined;
    const outer = parsed as Record<string, unknown>;
    // OpenAI `{error:{…}}`, Google `{error:{code,message,status}}`, Anthropic `{type:"error",error:{type,message}}`.
    const body = (outer.error && typeof outer.error === "object" ? outer.error : outer) as Record<
      string,
      unknown
    >;
    const str = (value: unknown) => (typeof value === "string" ? value : undefined);
    return {
      message: str(body.message),
      type: str(body.type),
      code: typeof body.code === "number" || typeof body.code === "string" ? body.code : undefined,
      status: str(body.status),
    };
  } catch {
    return undefined;
  }
}

const SHAPE = /^\s*(.*?)\s+(?:API\s+)?error\s*\((\d{3})\)\s*:?\s*([\s\S]*)$/i;

/**
 * Turns "OpenAI API error (401): {json}" into a sentence with the fix. Only known shapes are
 * rewritten; anything else returns undefined so the caller shows the text untouched.
 */
export function describeProviderError(raw: string): PlainError | undefined {
  const match = SHAPE.exec(raw);
  if (!match) return undefined;
  const provider = match[1]?.trim() || "The provider";
  const status = Number(match[2]);
  const body = readBody(match[3] ?? "");
  const detail = body?.message?.trim();
  const kind = `${body?.type ?? ""} ${body?.code ?? ""} ${body?.status ?? ""}`.toLowerCase();
  const code = `(${status})`;
  let summary: string;
  if (status === 401 || kind.includes("authentication") || kind.includes("invalid_api_key")) {
    summary = `${provider} rejected the API key ${code}. Update it in Settings › Providers.`;
  } else if (kind.includes("insufficient_quota") || kind.includes("billing") || status === 402) {
    summary = `${provider} says the account is out of quota or credit ${code}. Check its plan and billing.`;
  } else if (status === 403) {
    summary = `${provider} denied access ${code}. The key may lack access to this model; check Settings › Providers.`;
  } else if (status === 404 || kind.includes("model_not_found")) {
    summary = `${provider} has no such model ${code}. Pick another model in the composer.`;
  } else if (status === 429) {
    summary = `${provider} is rate limiting requests ${code}. Wait a moment, then try again.`;
  } else if (status >= 500) {
    summary = `${provider} had a problem on its side ${code}. Try again shortly.`;
  } else if (detail) {
    summary = `${provider} rejected the request ${code}: ${detail}`;
  } else {
    return undefined;
  }
  return { summary, raw };
}
