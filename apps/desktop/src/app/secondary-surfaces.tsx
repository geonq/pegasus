import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { AppView, DesktopAppState, WorkspaceRecord } from "../../contracts/desktop-state";
import { updateSnapshot } from "./desktop-app-state";
import { getEffectiveModelRuntime } from "../features/settings/model-settings";
import {
  type CustomProviderConfig,
  type DesktopNotificationPermissionStatus,
} from "../../contracts/ipc";
import { CustomizePage } from "../features/extensions/customize-page";
import { SettingsView, type SettingsSection } from "../features/settings/settings-view";
import {
  CUSTOMIZE_SECTION_ID,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTIONS,
} from "../features/settings/settings-sections";
import { SettingsSelect } from "../features/settings/settings-controls";
import type { McpSettingsActions } from "../features/settings/settings-mcp-section";
import { SecondarySurface } from "./secondary-surface";

interface SecondarySurfacesProps {
  readonly api: NonNullable<typeof window.piApp>;
  readonly snapshot: DesktopAppState;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly activeView: Extract<AppView, "settings" | "skills" | "extensions">;
  readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
  readonly settingsSection: SettingsSection;
  readonly onSelectSettingsSection: (section: SettingsSection) => void;
  readonly settingsWorkspaceId: string;
  readonly onSelectSettingsWorkspace: (workspaceId: string) => void;
  readonly skillsWorkspaceId: string;
  readonly onSelectSkillsWorkspace: (workspaceId: string) => void;
  readonly extensionsWorkspaceId: string;
  readonly onSelectExtensionsWorkspace: (workspaceId: string) => void;
  readonly onBack: () => void;
  /** Settings and the Skills and extensions page are separate app views. */
  readonly onSelectView: (view: Extract<AppView, "settings" | "skills" | "extensions">) => void;
  readonly onTrySkill: (command: string) => void;
}

export function SecondarySurfaces({
  api,
  snapshot,
  setSnapshot,
  activeView,
  rootWorkspaceOptions,
  settingsSection,
  onSelectSettingsSection,
  settingsWorkspaceId,
  onSelectSettingsWorkspace,
  skillsWorkspaceId,
  onSelectSkillsWorkspace,
  extensionsWorkspaceId,
  onSelectExtensionsWorkspace,
  onBack,
  onSelectView,
  onTrySkill,
}: SecondarySurfacesProps) {
  const [notificationPermissionStatus, setNotificationPermissionStatus] =
    useState<DesktopNotificationPermissionStatus>("unknown");
  const [notificationPermissionPending, setNotificationPermissionPending] = useState(false);
  const [runtimeLoadState, setRuntimeLoadState] = useState<{
    readonly workspaceId: string;
    readonly status: "loading" | "error" | "ready";
  } | null>(null);
  const runtimeLoadGeneration = useRef(0);

  const settingsWorkspace = settingsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === settingsWorkspaceId)
    : undefined;
  const skillsWorkspace = skillsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === skillsWorkspaceId)
    : undefined;
  const extensionsWorkspace = extensionsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === extensionsWorkspaceId)
    : undefined;
  const customizeTab = activeView === "settings" ? undefined : activeView;
  const customizeWorkspace = customizeTab === "extensions" ? extensionsWorkspace : skillsWorkspace;
  const providerWorkspace =
    rootWorkspaceOptions.find((workspace) => workspace.id === snapshot.selectedWorkspaceId) ??
    rootWorkspaceOptions[0];
  const providerPageActive = activeView === "settings" && settingsSection === "providers";
  const skillsRuntime = skillsWorkspace
    ? snapshot.runtimeByWorkspace[skillsWorkspace.id]
    : undefined;
  const extensionsRuntime = extensionsWorkspace
    ? snapshot.runtimeByWorkspace[extensionsWorkspace.id]
    : undefined;
  const providerModelRuntime = getEffectiveModelRuntime(snapshot, providerWorkspace);
  const settingsRuntime = settingsWorkspace
    ? snapshot.runtimeByWorkspace[settingsWorkspace.id]
    : undefined;
  const settingsModelRuntime = getEffectiveModelRuntime(snapshot, settingsWorkspace);
  const extensionsCommandCompatibility = extensionsWorkspace
    ? (snapshot.extensionCommandCompatibilityByWorkspace[extensionsWorkspace.id] ?? [])
    : [];

  const runtimeWorkspaceId =
    customizeTab === "skills"
      ? skillsWorkspace?.id
      : customizeTab === "extensions"
        ? extensionsWorkspace?.id
        : providerPageActive
          ? providerWorkspace?.id
          : undefined;
  const runtimeWorkspaceLoaded = runtimeWorkspaceId
    ? Boolean(snapshot.runtimeByWorkspace[runtimeWorkspaceId])
    : false;
  const runtimeLoadRequestWorkspaceId = providerPageActive
    ? providerWorkspace?.id
    : !runtimeWorkspaceLoaded
      ? runtimeWorkspaceId
      : undefined;
  const runtimeLoadRequestRefresh = providerPageActive;
  const currentRuntimeLoadState =
    runtimeWorkspaceId && runtimeLoadState?.workspaceId === runtimeWorkspaceId
      ? runtimeLoadState.status
      : undefined;
  const runtimeLoadStatus = providerPageActive
    ? (currentRuntimeLoadState ?? (runtimeWorkspaceLoaded ? "ready" : "loading"))
    : runtimeWorkspaceLoaded
      ? "ready"
      : (currentRuntimeLoadState ?? "loading");

  const requestWorkspaceRuntime = useCallback(
    (workspaceId: string, refresh = false) => {
      const generation = ++runtimeLoadGeneration.current;
      setRuntimeLoadState({ workspaceId, status: "loading" });
      return updateSnapshot(setSnapshot, () =>
        api.loadWorkspaceRuntime(workspaceId, refresh ? { refresh: true } : undefined),
      ).then(
        (state) => {
          if (runtimeLoadGeneration.current === generation) {
            setRuntimeLoadState({ workspaceId, status: "ready" });
          }
          return state;
        },
        (error: unknown) => {
          if (runtimeLoadGeneration.current === generation) {
            setRuntimeLoadState({ workspaceId, status: "error" });
          }
          throw error;
        },
      );
    },
    [api, setSnapshot],
  );

  useEffect(() => {
    if (!runtimeLoadRequestWorkspaceId) return;
    void requestWorkspaceRuntime(runtimeLoadRequestWorkspaceId, runtimeLoadRequestRefresh).catch(
      (error: unknown) => {
        console.error("[renderer] loadWorkspaceRuntime failed", error);
      },
    );
    return () => {
      runtimeLoadGeneration.current += 1;
    };
  }, [requestWorkspaceRuntime, runtimeLoadRequestRefresh, runtimeLoadRequestWorkspaceId]);

  useEffect(() => {
    const piApi = window.piApp;
    if (!piApi?.onNotificationPermissionStatusChanged) {
      return;
    }
    return piApi.onNotificationPermissionStatusChanged((status) => {
      setNotificationPermissionStatus(status);
    });
  }, []);

  const refreshNotificationPermissionStatus = useCallback(() => {
    if (!api.getNotificationPermissionStatus) {
      return Promise.resolve("unknown" as DesktopNotificationPermissionStatus);
    }
    return api.getNotificationPermissionStatus().then((status) => {
      setNotificationPermissionStatus(status);
      return status;
    });
  }, [api]);

  useEffect(() => {
    if (activeView !== "settings" || settingsSection !== "notifications") {
      return;
    }
    void refreshNotificationPermissionStatus().catch((error: unknown) => {
      console.error("[renderer] refreshNotificationPermissionStatus failed", error);
    });
  }, [activeView, refreshNotificationPermissionStatus, settingsSection]);

  const handleSetDefaultModel = (provider: string, modelId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setDefaultModel(settingsWorkspace.id, provider, modelId),
    ).catch((error: unknown) => {
      console.error("[renderer] setDefaultModel failed", error);
    });
  };

  const handleSetThinkingLevel = (
    thinkingLevel: RuntimeSnapshot["settings"]["defaultThinkingLevel"],
  ) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setDefaultThinkingLevel(settingsWorkspace.id, thinkingLevel),
    ).catch((error: unknown) => {
      console.error("[renderer] setDefaultThinkingLevel failed", error);
    });
  };

  const handleToggleSkillCommands = (enabled: boolean) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setEnableSkillCommands(settingsWorkspace.id, enabled),
    ).catch((error: unknown) => {
      console.error("[renderer] setEnableSkillCommands failed", error);
    });
  };

  const handleSetScopedModelPatterns = (patterns: readonly string[]) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setScopedModelPatterns(settingsWorkspace.id, patterns),
    ).catch((error: unknown) => {
      console.error("[renderer] setScopedModelPatterns failed", error);
    });
  };

  const handleSetModelSettingsScopeMode = (mode: "app-global" | "per-repo") => {
    void updateSnapshot(setSnapshot, () => api.setModelSettingsScopeMode(mode)).catch(
      (error: unknown) => {
        console.error("[renderer] setModelSettingsScopeMode failed", error);
      },
    );
  };

  const handleLoginProvider = (providerId: string) => {
    if (!providerWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.loginProvider(providerWorkspace.id, providerId),
    ).catch((error: unknown) => {
      console.error("[renderer] loginProvider failed", error);
    });
  };

  const handleLogoutProvider = (providerId: string) => {
    if (!providerWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.logoutProvider(providerWorkspace.id, providerId),
    ).catch((error: unknown) => {
      console.error("[renderer] logoutProvider failed", error);
    });
  };

  const handleSetProviderApiKey = async (
    providerId: string,
    apiKey: string,
  ): Promise<string | undefined> => {
    if (!providerWorkspace) {
      return "Open a project to load shared provider settings.";
    }
    const state = await updateSnapshot(setSnapshot, () =>
      api.setProviderApiKey(providerWorkspace.id, providerId, apiKey),
    );
    return state.lastError;
  };

  const handleRemoveProviderApiKey = async (providerId: string): Promise<string | undefined> => {
    if (!providerWorkspace) {
      return "Open a project to load shared provider settings.";
    }
    const state = await updateSnapshot(setSnapshot, () =>
      api.logoutProvider(providerWorkspace.id, providerId),
    );
    return state.lastError;
  };

  const handleSaveCustomProvider = async (
    config: CustomProviderConfig,
  ): Promise<string | undefined> => {
    if (!providerWorkspace) {
      return "Open a project to load shared provider settings.";
    }
    const state = await updateSnapshot(setSnapshot, () =>
      api.setCustomProvider(providerWorkspace.id, config),
    );
    return state.lastError;
  };

  const handleDeleteCustomProvider = async (providerId: string): Promise<string | undefined> => {
    if (!providerWorkspace) {
      return "Open a project to load shared provider settings.";
    }
    const state = await updateSnapshot(setSnapshot, () =>
      api.deleteCustomProvider(providerWorkspace.id, providerId),
    );
    return state.lastError;
  };

  const updateSettingsWorkspace = async (
    update: (workspaceId: string) => Promise<DesktopAppState>,
  ): Promise<string | undefined> => {
    if (!settingsWorkspace) {
      return "Select a workspace first.";
    }
    const state = await updateSnapshot(setSnapshot, () => update(settingsWorkspace.id));
    return state.lastError;
  };

  const mcpActions: McpSettingsActions = {
    onAddServer: (server) =>
      updateSettingsWorkspace((workspaceId) => api.addMcpServer(workspaceId, server)),
    onRemoveServer: (name) =>
      updateSettingsWorkspace((workspaceId) => api.removeMcpServer(workspaceId, name)),
    onSetServerEnabled: (scope, name, enabled) =>
      updateSettingsWorkspace((workspaceId) =>
        api.setMcpServerEnabled(workspaceId, scope, name, enabled),
      ),
    onSetCodemodeAlwaysOn: (alwaysOn) =>
      updateSettingsWorkspace((workspaceId) => api.setCodemodeAlwaysOn(workspaceId, alwaysOn)),
  };

  const handleToggleSkill = (filePath: string, enabled: boolean) => {
    if (!skillsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setSkillEnabled(skillsWorkspace.id, filePath, enabled),
    ).catch((error: unknown) => {
      console.error("[renderer] setSkillEnabled failed", error);
    });
  };

  const handleOpenSkillFolder = (filePath: string) => {
    if (!skillsWorkspace) {
      return;
    }
    void api.openSkillInFinder(skillsWorkspace.id, filePath).catch((error: unknown) => {
      console.error("[renderer] openSkillInFinder failed", error);
    });
  };

  const handleToggleExtension = (filePath: string, enabled: boolean) => {
    if (!extensionsWorkspace) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.setExtensionEnabled(extensionsWorkspace.id, filePath, enabled),
    ).catch((error: unknown) => {
      console.error("[renderer] setExtensionEnabled failed", error);
    });
  };

  const handleOpenExtensionFolder = (filePath: string) => {
    if (!extensionsWorkspace) {
      return;
    }
    void api.openExtensionInFinder(extensionsWorkspace.id, filePath).catch((error: unknown) => {
      console.error("[renderer] openExtensionInFinder failed", error);
    });
  };

  const handleSetThemeMode = (mode: "system" | "light" | "dark") => {
    void updateSnapshot(setSnapshot, () => api.setThemeMode(mode)).catch((error: unknown) => {
      console.error("[renderer] setThemeMode failed", error);
    });
  };

  const handleSetThemePresetId = (presetId: DesktopAppState["themePresetId"]) => {
    void updateSnapshot(setSnapshot, () => api.setThemePresetId(presetId)).catch(
      (error: unknown) => {
        console.error("[renderer] setThemePresetId failed", error);
      },
    );
  };

  const handleSetNotificationPreferences = (
    preferences: Partial<DesktopAppState["notificationPreferences"]>,
  ) => {
    void updateSnapshot(setSnapshot, () => api.setNotificationPreferences(preferences)).catch(
      (error: unknown) => {
        console.error("[renderer] setNotificationPreferences failed", error);
      },
    );
  };

  const handleSetIntegratedTerminalShell = (shellPath: string) => {
    void updateSnapshot(setSnapshot, () => api.setIntegratedTerminalShell(shellPath)).catch(
      (error: unknown) => {
        console.error("[renderer] setIntegratedTerminalShell failed", error);
      },
    );
  };

  const handleRequestNotificationPermission = () => {
    if (!api.requestNotificationPermission) {
      return;
    }
    setNotificationPermissionPending(true);
    void api
      .requestNotificationPermission()
      .then((status) => {
        setNotificationPermissionStatus(status);
      })
      .finally(() => {
        setNotificationPermissionPending(false);
      })
      .catch((error: unknown) => {
        console.error("[renderer] api failed", error);
      });
  };

  const handleOpenSystemNotificationSettings = () => {
    if (!api.openSystemNotificationSettings) {
      return;
    }
    setNotificationPermissionPending(true);
    void api
      .openSystemNotificationSettings()
      .finally(() => {
        setNotificationPermissionPending(false);
      })
      .catch((error: unknown) => {
        console.error("[renderer] openSystemNotificationSettings failed", error);
      });
  };

  const workspacePicker = (
    value: WorkspaceRecord | undefined,
    onChange: (workspaceId: string) => void,
  ) =>
    rootWorkspaceOptions.length > 0 ? (
      <SettingsSelect
        label="Workspace"
        options={rootWorkspaceOptions.map((workspace) => ({
          value: workspace.id,
          label: workspace.name,
        }))}
        value={value?.id}
        onChange={onChange}
      />
    ) : null;

  return (
    <SecondarySurface
      activeNavId={customizeTab ? CUSTOMIZE_SECTION_ID : settingsSection}
      navItems={SETTINGS_NAV_ITEMS}
      onBack={onBack}
      onSelectNav={(id) => {
        if (id === CUSTOMIZE_SECTION_ID) {
          if (!customizeTab) onSelectView("skills");
          return;
        }
        const section = SETTINGS_SECTIONS.find((definition) => definition.id === id);
        if (!section) return;
        onSelectSettingsSection(section.id);
        if (customizeTab) onSelectView("settings");
      }}
      testId={customizeTab ? `${customizeTab}-surface` : "settings-surface"}
      title="Settings"
    >
      {customizeTab ? (
        <CustomizePage
          commandCompatibility={extensionsCommandCompatibility}
          extensionsRuntime={extensionsRuntime}
          runtimeLoadStatus={runtimeLoadStatus}
          skillsRuntime={skillsRuntime}
          tab={customizeTab}
          workspace={customizeWorkspace}
          workspacePicker={
            customizeTab === "extensions"
              ? workspacePicker(extensionsWorkspace, onSelectExtensionsWorkspace)
              : workspacePicker(skillsWorkspace, onSelectSkillsWorkspace)
          }
          onOpenExtensionFolder={handleOpenExtensionFolder}
          onOpenSkillFolder={handleOpenSkillFolder}
          onRefresh={() => {
            if (!customizeWorkspace) return;
            // The explicit Refresh also reloads open threads (when idle), so edited extensions
            // and skills take effect; opening a settings page only reloads the runtime.
            const workspaceId = customizeWorkspace.id;
            void updateSnapshot(setSnapshot, () => api.refreshRuntime(workspaceId)).catch(
              (error: unknown) => {
                console.error("[renderer] refreshRuntime failed", error);
              },
            );
          }}
          onSelectTab={onSelectView}
          onToggleExtension={handleToggleExtension}
          onToggleSkill={handleToggleSkill}
          onTryCommand={onTrySkill}
        />
      ) : (
        <SettingsView
          workspace={settingsSection === "providers" ? providerWorkspace : settingsWorkspace}
          runtime={
            settingsSection === "providers"
              ? providerModelRuntime
              : settingsSection === "models"
                ? settingsModelRuntime
                : settingsRuntime
          }
          platform={api.platform}
          runtimeLoadStatus={
            settingsSection === "providers"
              ? providerWorkspace
                ? runtimeLoadStatus
                : "unavailable"
              : undefined
          }
          onRetryRuntime={
            providerWorkspace
              ? () => {
                  void requestWorkspaceRuntime(providerWorkspace.id, true).catch(
                    (error: unknown) => {
                      console.error("[renderer] loadWorkspaceRuntime refresh failed", error);
                    },
                  );
                }
              : undefined
          }
          headerAccessory={
            settingsSection === "mcp" ||
            (settingsSection === "models" && snapshot.modelSettingsScopeMode === "per-repo")
              ? workspacePicker(settingsWorkspace, onSelectSettingsWorkspace)
              : undefined
          }
          section={settingsSection}
          notificationPreferences={snapshot.notificationPreferences}
          notificationPermissionStatus={notificationPermissionStatus}
          notificationPermissionPending={notificationPermissionPending}
          modelSettingsScopeMode={snapshot.modelSettingsScopeMode}
          integratedTerminalShell={snapshot.integratedTerminalShell}
          themeMode={snapshot.themeMode}
          themePresetId={snapshot.themePresetId}
          enableTransparency={snapshot.enableTransparency}
          onLoginProvider={handleLoginProvider}
          onSelectSection={onSelectSettingsSection}
          onLogoutProvider={handleLogoutProvider}
          onSetProviderApiKey={handleSetProviderApiKey}
          onRemoveProviderApiKey={handleRemoveProviderApiKey}
          onSaveCustomProvider={handleSaveCustomProvider}
          onDeleteCustomProvider={handleDeleteCustomProvider}
          onSetModelSettingsScopeMode={handleSetModelSettingsScopeMode}
          onSetDefaultModel={handleSetDefaultModel}
          onSetNotificationPreferences={handleSetNotificationPreferences}
          onSetIntegratedTerminalShell={handleSetIntegratedTerminalShell}
          onRequestNotificationPermission={handleRequestNotificationPermission}
          onOpenSystemNotificationSettings={handleOpenSystemNotificationSettings}
          onSetScopedModelPatterns={handleSetScopedModelPatterns}
          onSetThemeMode={handleSetThemeMode}
          onSetThemePresetId={handleSetThemePresetId}
          onSetThinkingLevel={handleSetThinkingLevel}
          onToggleSkillCommands={handleToggleSkillCommands}
          mcpActions={mcpActions}
          onSetEnableTransparency={(enabled) => {
            void updateSnapshot(setSnapshot, () => api.setEnableTransparency(enabled)).catch(
              (error: unknown) => {
                console.error("[renderer] setEnableTransparency failed", error);
              },
            );
          }}
        />
      )}
    </SecondarySurface>
  );
}
