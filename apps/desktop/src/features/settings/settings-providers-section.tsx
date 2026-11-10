import { useEffect, useMemo, useState } from "react";
import type { RuntimeProviderRecord, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { SearchIcon } from "../../ui/icons";
import type { CustomProviderConfig } from "../../../contracts/ipc";
import { SettingsCustomEndpointsSection } from "./settings-custom-endpoints-section";
import { ClaudeAccountRow, filterProviders, ProviderRow, SettingsGroup } from "./settings-utils";

interface SettingsProvidersSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onSetProviderApiKey: (providerId: string, apiKey: string) => Promise<string | undefined>;
  readonly onRemoveProviderApiKey: (providerId: string) => Promise<string | undefined>;
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onDeleteCustomProvider: (providerId: string) => Promise<string | undefined>;
}

import { claudeRowView, subscriptionAccount, subscriptionGroups } from "./subscription-accounts";
import type { ClaudeSlot } from "../../../contracts/usage";

const COLLAPSED_AVAILABLE_COUNT = 8;

/** Sign-in providers first, then API key providers, then the rest, each alphabetical. */
function compareAvailableProviders(left: RuntimeProviderRecord, right: RuntimeProviderRecord) {
  const rank = (provider: RuntimeProviderRecord) =>
    provider.oauthSupported || provider.id === "antigravity"
      ? 0
      : provider.apiKeySetupSupported
        ? 1
        : 2;
  return rank(left) - rank(right) || left.name.localeCompare(right.name);
}

export function SettingsProvidersSection({
  runtime,
  onLoginProvider,
  onLogoutProvider,
  onSetProviderApiKey,
  onRemoveProviderApiKey,
  onSaveCustomProvider,
  onDeleteCustomProvider,
}: SettingsProvidersSectionProps) {
  const [providerQuery, setProviderQuery] = useState("");
  const [showAllAvailable, setShowAllAvailable] = useState(false);
  const [apiKeyProviderId, setApiKeyProviderId] = useState<string | undefined>();
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | undefined>();
  const [apiKeyPending, setApiKeyPending] = useState(false);

  const [claudeSlots, setClaudeSlots] = useState<readonly ClaudeSlot[] | undefined>();
  // Re-read after every runtime change: signing in or out updates the snapshot.
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const slots = await window.piApp?.getClaudeSlots?.();
        if (current) setClaudeSlots(slots);
      } catch (error) {
        console.error("[renderer] getClaudeSlots failed", error);
      }
    })();
    return () => {
      current = false;
    };
  }, [runtime]);

  const providers = runtime?.providers ?? [];
  const accountGroups = subscriptionGroups(
    providers.map((provider) =>
      subscriptionAccount(provider.id)?.family === "anthropic"
        ? {
            ...provider,
            hasAuth: claudeRowView(provider.id, provider.hasAuth, claudeSlots).signedIn,
          }
        : provider,
    ),
  );
  const accountIds = new Set(
    accountGroups.flatMap((group) => group.accounts.map((provider) => provider.id)),
  );
  // Subscription sign-ins and their Claude Code slots are listed once, in Connected accounts below.
  const connectedProviders = providers.filter(
    (provider) =>
      provider.hasAuth &&
      !accountIds.has(provider.id) &&
      !provider.id.startsWith("claude-code-account-"),
  );
  const defaultProviderId = runtime?.settings.defaultProvider;
  const attentionProviders = providers.filter(
    (provider) => provider.id === defaultProviderId && !provider.hasAuth,
  );
  const availableProviders = providers
    .filter(
      (provider) =>
        !provider.hasAuth && provider.id !== defaultProviderId && !accountIds.has(provider.id),
    )
    .sort(compareAvailableProviders);
  const filteredAvailable = filterProviders(availableProviders, providerQuery);
  const expandAvailable = showAllAvailable || providerQuery.trim().length > 0;
  const shownAvailable = expandAvailable
    ? filteredAvailable
    : filteredAvailable.slice(0, COLLAPSED_AVAILABLE_COUNT);
  const hiddenAvailableCount = filteredAvailable.length - shownAvailable.length;
  const rowHandlers = {
    onLoginProvider,
    onLogoutProvider,
    onConfigureApiKey: (entry: RuntimeProviderRecord) => setApiKeyProviderId(entry.id),
  };
  const apiKeyProvider = apiKeyProviderId
    ? providers.find((provider) => provider.id === apiKeyProviderId)
    : undefined;
  const existingProviderIds = useMemo(() => providers.map((provider) => provider.id), [providers]);

  useEffect(() => {
    setApiKeyDraft("");
    setApiKeyError(undefined);
    setApiKeyPending(false);
  }, [apiKeyProviderId]);

  const closeApiKeyDialog = () => {
    if (apiKeyPending) {
      return;
    }
    setApiKeyProviderId(undefined);
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyProvider) {
      return;
    }
    setApiKeyPending(true);
    setApiKeyError(undefined);
    const nextError = await onSetProviderApiKey(apiKeyProvider.id, apiKeyDraft.trim());
    if (nextError) {
      setApiKeyPending(false);
      setApiKeyError(nextError);
      return;
    }
    setApiKeyProviderId(undefined);
  };

  const handleRemoveApiKey = async () => {
    if (!apiKeyProvider) {
      return;
    }
    setApiKeyPending(true);
    setApiKeyError(undefined);
    const nextError = await onRemoveProviderApiKey(apiKeyProvider.id);
    if (nextError) {
      setApiKeyPending(false);
      setApiKeyError(nextError);
      return;
    }
    setApiKeyProviderId(undefined);
  };

  return (
    <>
      {attentionProviders.length > 0 ? (
        <SettingsGroup
          title="Needs attention"
          description="Your default model uses this provider, but it is not connected."
        >
          {attentionProviders.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} {...rowHandlers} />
          ))}
        </SettingsGroup>
      ) : null}

      <section className="settings-section">
        <h3 className="settings-section__title">
          Connected <span className="resource-list__count">{connectedProviders.length}</span>
        </h3>
        <p className="settings-section__description">
          Connections are shared across every project in Pegasus.
        </p>
        <div className="settings-group">
          {connectedProviders.length > 0 ? (
            connectedProviders.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} {...rowHandlers} />
            ))
          ) : (
            <div className="settings-row">
              <span className="settings-row__description">
                {accountGroups.length > 0
                  ? "Your subscription accounts are listed below."
                  : "No providers connected yet. Sign in or add an API key below."}
              </span>
            </div>
          )}
        </div>
      </section>

      {accountGroups.length > 0 ? (
        <section
          className="settings-section subscription-accounts"
          aria-label="Subscription accounts"
        >
          <div className="subscription-accounts__intro">
            <div>
              <p className="subscription-accounts__eyebrow">Your workspace, your accounts</p>
              <h3 className="subscription-accounts__title">Connected accounts</h3>
            </div>
            <p className="settings-section__description">
              Each account has its own sign-in. Your first accounts stay connected.
            </p>
          </div>
          <div className="subscription-accounts__grid">
            {accountGroups.map((group) => {
              // Claude's sign-in state is the CLI slot's, so the header must count the same thing its rows show.
              const signedIn = group.accounts.map((provider) =>
                group.id === "anthropic"
                  ? claudeRowView(provider.id, provider.hasAuth, claudeSlots).signedIn
                  : provider.hasAuth,
              );
              const connected = signedIn.filter(Boolean).length;
              const next =
                group.id === "anthropic"
                  ? group.accounts.find(
                      (provider, index) => !signedIn[index] && provider.oauthSupported,
                    )
                  : group.next;
              return (
                <section
                  className="subscription-account-card"
                  key={group.id}
                  aria-label={`${group.name} accounts`}
                >
                  <header className="subscription-account-card__header">
                    <span
                      className={`subscription-account-card__mark subscription-account-card__mark--${group.id}`}
                      aria-hidden="true"
                    >
                      {group.mark}
                    </span>
                    <div className="subscription-account-card__heading">
                      <h4>{group.name}</h4>
                      <p>
                        {connected} of {group.accounts.length} connected
                      </p>
                    </div>
                    {next ? (
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => onLoginProvider(next.id)}
                      >
                        Add {group.shortName} account
                      </button>
                    ) : (
                      <span className="subscription-account-card__complete">All connected</span>
                    )}
                  </header>
                  <div className="subscription-account-card__rows">
                    {group.accounts.map((provider) =>
                      group.id === "anthropic" ? (
                        <ClaudeAccountRow
                          key={provider.id}
                          providerId={provider.id}
                          view={claudeRowView(provider.id, provider.hasAuth, claudeSlots)}
                          onLoginProvider={onLoginProvider}
                          onLogoutProvider={onLogoutProvider}
                        />
                      ) : (
                        <ProviderRow
                          key={provider.id}
                          provider={{
                            ...provider,
                            name: `Account ${subscriptionAccount(provider.id)!.number}`,
                          }}
                          {...rowHandlers}
                        />
                      ),
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          <p className="settings-section__description">
            Choose a model and account when starting a thread. Additional accounts do not combine
            provider quotas or caches.
          </p>
        </section>
      ) : null}
      <SettingsCustomEndpointsSection
        existingProviderIds={existingProviderIds}
        onSaveCustomProvider={onSaveCustomProvider}
        onDeleteCustomProvider={onDeleteCustomProvider}
      />

      <section className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">
            Available <span className="resource-list__count">{availableProviders.length}</span>
          </h3>
          <label className="resource-search">
            <SearchIcon />
            <input
              aria-label="Search providers"
              placeholder="Search providers"
              spellCheck={false}
              type="search"
              value={providerQuery}
              onChange={(event) => setProviderQuery(event.currentTarget.value)}
            />
          </label>
        </div>
        <p className="settings-section__description">
          Sign in with OAuth or save an API key to connect a provider.
        </p>
        <div className="settings-group" data-testid="settings-available-providers">
          {shownAvailable.length > 0 ? (
            shownAvailable.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} {...rowHandlers} />
            ))
          ) : (
            <div className="settings-row">
              <span className="settings-row__description">
                {providerQuery.trim()
                  ? `No providers match “${providerQuery.trim()}”.`
                  : "Every provider is connected."}
              </span>
            </div>
          )}
        </div>
        {hiddenAvailableCount > 0 ? (
          <button
            className="resource-list__more"
            type="button"
            onClick={() => setShowAllAvailable(true)}
          >
            Show {hiddenAvailableCount} more
          </button>
        ) : null}
      </section>

      {apiKeyProvider ? (
        <ProviderApiKeyDialog
          provider={apiKeyProvider}
          draft={apiKeyDraft}
          error={apiKeyError}
          pending={apiKeyPending}
          onChangeDraft={setApiKeyDraft}
          onClose={closeApiKeyDialog}
          onRemove={apiKeyProvider.authSource === "auth_file" ? handleRemoveApiKey : undefined}
          onSave={handleSaveApiKey}
        />
      ) : null}
    </>
  );
}

function ProviderApiKeyDialog({
  provider,
  draft,
  error,
  pending,
  onChangeDraft,
  onClose,
  onRemove,
  onSave,
}: {
  readonly provider: RuntimeSnapshot["providers"][number];
  readonly draft: string;
  readonly error?: string;
  readonly pending: boolean;
  readonly onChangeDraft: (value: string) => void;
  readonly onClose: () => void;
  readonly onRemove?: () => Promise<void>;
  readonly onSave: () => Promise<void>;
}) {
  const title = provider.authSource === "auth_file" ? "Manage API key" : "Set API key";
  const body =
    provider.authSource === "auth_file"
      ? `Replace or remove the saved API key for ${provider.name}.`
      : `Save an API key locally for ${provider.name}.`;

  return (
    <div className="extension-dialog-backdrop">
      <div className="extension-dialog" data-testid="provider-api-key-dialog">
        <div className="extension-dialog__title">{title}</div>
        <p className="extension-dialog__body">{body}</p>
        <input
          aria-label={`${provider.name} API key`}
          autoComplete="off"
          autoFocus
          className="settings-search"
          disabled={pending}
          placeholder="Enter API key…"
          spellCheck={false}
          type="password"
          value={draft}
          onChange={(event) => onChangeDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "Enter" && draft.trim()) {
              event.preventDefault();
              void onSave().catch((error: unknown) => {
                console.error("[renderer] onSave failed", error);
              });
            }
          }}
        />
        {error ? <p className="extension-dialog__body settings-warning">{error}</p> : null}
        <div className="extension-dialog__actions">
          <button
            className="button button--secondary"
            disabled={pending}
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          {onRemove ? (
            <button
              className="button button--secondary"
              disabled={pending}
              type="button"
              onClick={() =>
                void onRemove().catch((error: unknown) => {
                  console.error("[renderer] onRemove failed", error);
                })
              }
            >
              Remove saved key
            </button>
          ) : null}
          <button
            className="button"
            disabled={pending || draft.trim().length === 0}
            type="button"
            onClick={() =>
              void onSave().catch((error: unknown) => {
                console.error("[renderer] onSave failed", error);
              })
            }
          >
            {provider.authSource === "auth_file" ? "Save key" : "Set API key"}
          </button>
        </div>
      </div>
    </div>
  );
}
