import type { RuntimeProviderRecord } from "@pi-gui/session-driver/runtime-types";
import type { ClaudeSlot } from "../../../contracts/usage";

export const SUBSCRIPTION_FAMILIES = [
  { id: "openai", name: "OpenAI / Codex", shortName: "Codex", mark: "O" },
  { id: "anthropic", name: "Claude", shortName: "Claude", mark: "C" },
] as const;

export function subscriptionAccount(
  id: string,
): { family: "openai" | "anthropic"; number: number } | undefined {
  if (id === "openai" || id === "anthropic") return { family: id, number: 1 };
  const match = /^(openai|anthropic)-account-([2-5])$/.exec(id);
  return match
    ? { family: match[1] as "openai" | "anthropic", number: Number(match[2]) }
    : undefined;
}

export function subscriptionGroups<
  T extends Pick<RuntimeProviderRecord, "id" | "hasAuth" | "oauthSupported">,
>(providers: readonly T[]) {
  return SUBSCRIPTION_FAMILIES.flatMap((family) => {
    const accounts = providers
      .filter((provider) => subscriptionAccount(provider.id)?.family === family.id)
      .sort((a, b) => subscriptionAccount(a.id)!.number - subscriptionAccount(b.id)!.number);
    if (!accounts.some((provider) => subscriptionAccount(provider.id)!.number > 1)) return [];
    return [
      {
        ...family,
        accounts,
        connected: accounts.filter((provider) => provider.hasAuth).length,
        next: accounts.find((provider) => !provider.hasAuth && provider.oauthSupported),
      },
    ];
  });
}

export interface ClaudeRowView {
  readonly title: string;
  readonly status: string;
  readonly signedIn: boolean;
  readonly warning?: string;
}

/**
 * Plain-words state of one Claude account row. `slots` come from the CLI slot files; without them
 * (older host) the runtime's own `hasAuth` decides and no name or duplicate check is possible.
 */
export function claudeRowView(
  providerId: string,
  hasAuth: boolean,
  slots: readonly ClaudeSlot[] | undefined,
): ClaudeRowView {
  const number = subscriptionAccount(providerId)!.number;
  const slot = slots?.find((entry) => entry.slot === number);
  const signedIn = slot ? slot.signedIn : hasAuth;
  if (!signedIn) return { title: `Account ${number}`, status: "Not signed in", signedIn };
  const plan = slot?.plan ? slot.plan[0]!.toUpperCase() + slot.plan.slice(1) : undefined;
  const status = ["Signed in", plan].filter(Boolean).join(" · ");
  const first =
    slot?.accountUuid &&
    slots!.find(
      (entry) => entry.signedIn && entry.accountUuid === slot.accountUuid && entry.slot < number,
    );
  return {
    title: slot?.name ? `${slot.name} · Account ${number}` : `Account ${number}`,
    status,
    signedIn,
    ...(first
      ? {
          warning: `Same Claude account as Account ${first.slot}. Sign out, then sign in with a different account.`,
        }
      : {}),
  };
}
