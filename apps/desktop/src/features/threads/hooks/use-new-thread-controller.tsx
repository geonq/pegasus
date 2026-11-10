import type { ComparedModel } from "../../conversation/model-selector";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import type { ExtensionFlagValues } from "@pi-gui/session-driver";
import {
  type AppView,
  type ComposerAttachment,
  type DesktopAppState,
  type NewThreadEnvironment,
  type StartThreadInput,
  type WorkspaceRecord,
} from "../../../../contracts/desktop-state";
import { acceptComposerAttachments } from "../../../../contracts/composer-attachments";
import { switchActiveView, updateSnapshot } from "../../../app/desktop-app-state";
import {
  extractFilesFromDataTransfer,
  extractImageFilesFromClipboardData,
  handleClipboardImageShortcut,
  readComposerAttachmentsFromFiles,
} from "../../conversation/composer-attachments";
import { isModelSelectable, parseTreeComposerCommand } from "../../conversation/composer-commands";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import { deriveModelOnboardingState } from "../../settings/model-onboarding";
import { getEffectiveModelRuntime } from "../../settings/model-settings";
import type { SettingsSection } from "../../settings/settings-view";
import { useMentionMenu } from "../../conversation/hooks/use-mention-menu";
import { useSlashMenu } from "../../conversation/hooks/use-slash-menu";
import { usePromptHistory } from "../../conversation/hooks/use-prompt-history";
import { resolveRepoWorkspaceId } from "../../../../contracts/workspace-roots";

interface UseNewThreadControllerParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly openSettings: (workspaceId?: string, section?: SettingsSection) => void;
  readonly flushComposerDraft: () => void;
}

export function useNewThreadController(params: UseNewThreadControllerParams) {
  const {
    api,
    snapshot,
    setSnapshot,
    rootWorkspace,
    rootWorkspaceOptions,
    visibleWorkspaces,
    selectedWorkspace,
    openSettings,
    flushComposerDraft,
  } = params;

  const [pendingWorkspaceId, setPendingWorkspaceId] = useState("");
  const [rootWorkspaceId, setRootWorkspaceId] = useState("");
  const [environment, setEnvironment] = useState<NewThreadEnvironment>("local");
  const [prompt, setPrompt] = useState("");
  const { recordSentPrompt, handlePromptHistoryKeyDown } = usePromptHistory();
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [provider, setProvider] = useState<string | undefined>();
  const [modelId, setModelId] = useState<string | undefined>();
  // More models that get the same prompt, each in its own worktree (Shift-click in the picker).
  const [compareModels, setCompareModels] = useState<readonly ComparedModel[]>([]);
  const toggleCompareModel = useCallback((nextProvider: string, nextModelId: string) => {
    setCompareModels((current) =>
      current.some((entry) => entry.provider === nextProvider && entry.modelId === nextModelId)
        ? current.filter(
            (entry) => !(entry.provider === nextProvider && entry.modelId === nextModelId),
          )
        : [...current, { provider: nextProvider, modelId: nextModelId }].slice(0, 4),
    );
  }, []);
  const [thinkingLevel, setThinkingLevel] = useState<string | undefined>();
  // Flag edits on this surface, laid over the workspace's remembered defaults.
  const [extensionFlagEdits, setExtensionFlagEdits] = useState<ExtensionFlagValues>({});
  const [composerError, setComposerError] = useState<string | undefined>();
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const previousActiveViewRef = useRef<AppView | null>(null);
  // Set while an in-app open is switching to New thread, so its chosen folder
  // is not replaced by the selected one when the view change arrives.
  const openedInAppRef = useRef(false);

  const workspace =
    rootWorkspaceOptions.find((entry) => entry.id === rootWorkspaceId) ?? rootWorkspaceOptions[0];
  const runtime = snapshot ? getEffectiveModelRuntime(snapshot, workspace) : undefined;
  const defaultEnabled = isModelSelectable(
    runtime,
    runtime?.settings.defaultProvider,
    runtime?.settings.defaultModelId,
  );
  const resolvedProvider =
    provider ?? (defaultEnabled ? runtime?.settings.defaultProvider : undefined);
  const resolvedModelId =
    modelId ?? (defaultEnabled ? runtime?.settings.defaultModelId : undefined);
  const resolvedThinkingLevel = thinkingLevel ?? runtime?.settings.defaultThinkingLevel;
  const workspaceFlagDefaults = workspace
    ? snapshot?.extensionFlagsByWorkspace[workspace.id]
    : undefined;
  const extensionFlags = useMemo(
    () => ({ ...workspaceFlagDefaults, ...extensionFlagEdits }),
    [workspaceFlagDefaults, extensionFlagEdits],
  );
  const setExtensionFlag = useCallback((name: string, value: boolean | string) => {
    setExtensionFlagEdits((current) => ({ ...current, [name]: value }));
  }, []);
  const modelOnboarding = deriveModelOnboardingState(runtime, {
    provider: resolvedProvider,
    modelId: resolvedModelId,
  });

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }, []);

  const updatePrompt = useCallback((value: SetStateAction<string>) => {
    setComposerError(undefined);
    setPrompt(value);
  }, []);

  const addAttachments = useCallback(
    (files: File[]) => {
      void readComposerAttachmentsFromFiles(files, attachments)
        .then((added) => {
          if (added.length === 0) {
            return;
          }
          setAttachments((current) => {
            const accepted = acceptComposerAttachments(current, added);
            if (!accepted.ok) {
              setComposerError(accepted.error.message);
              return current;
            }
            setComposerError(undefined);
            return [...current, ...accepted.attachments];
          });
        })
        .catch((error: unknown) => {
          setComposerError(error instanceof Error ? error.message : String(error));
        });
    },
    [attachments],
  );

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const appendAttachment = useCallback((attachment: ComposerAttachment) => {
    setAttachments((current) => {
      const accepted = acceptComposerAttachments(current, [attachment]);
      if (!accepted.ok) {
        setComposerError(accepted.error.message);
        return current;
      }
      setComposerError(undefined);
      return [...current, ...accepted.attachments];
    });
  }, []);

  // Each fresh New thread surface gets a generation, so a start still in flight from an
  // earlier surface neither blocks nor clears what the user types into this one.
  const surfaceGenerationRef = useRef(0);
  const startingGenerationRef = useRef<number | undefined>(undefined);
  const resetSurface = useCallback(
    (workspaceId?: string) => {
      surfaceGenerationRef.current += 1;
      const nextWorkspaceId =
        (workspaceId &&
          (rootWorkspaceOptions.find((w) => w.id === workspaceId)?.id ||
            (snapshot ? resolveRepoWorkspaceId(snapshot.workspaces, workspaceId) : undefined))) ||
        rootWorkspace?.id ||
        visibleWorkspaces[0]?.id ||
        "";
      if (nextWorkspaceId) {
        setRootWorkspaceId(nextWorkspaceId);
      }
      setEnvironment("local");
      setPrompt("");
      setAttachments([]);
      setProvider(undefined);
      setModelId(undefined);
      setThinkingLevel(undefined);
      setExtensionFlagEdits({});
      setComposerError(undefined);
    },
    [rootWorkspace?.id, rootWorkspaceOptions, snapshot, visibleWorkspaces],
  );

  const openSurface = useCallback(
    (workspaceId?: string) => {
      // Save the outgoing conversation before the new-thread flow can change its selection.
      flushComposerDraft();
      setPendingWorkspaceId("");
      resetSurface(workspaceId);
      openedInAppRef.current = true;
      if (api) {
        void switchActiveView(
          setSnapshot,
          () => api.setActiveView("new-thread"),
          "new-thread",
        ).catch((error: unknown) => {
          console.error("[renderer] setActiveView failed", error);
        });
      }
    },
    [api, flushComposerDraft, resetSurface, setSnapshot],
  );

  const selectWorkspace = useCallback((workspaceId: string) => {
    setPendingWorkspaceId("");
    setRootWorkspaceId(workspaceId);
    setAttachments([]);
    setProvider(undefined);
    setModelId(undefined);
    setThinkingLevel(undefined);
    setExtensionFlagEdits({});
    setComposerError(undefined);
  }, []);

  const slashMenu = useSlashMenu({
    composerDraft: prompt,
    setComposerDraft: updatePrompt,
    selectedRuntime: runtime,
    selectedModelRuntime: runtime,
    sessionCommands: [],
    commandCompatibility: [],
    selectedSessionKey: `new-thread:${workspace?.id ?? ""}`,
    selectedSession: undefined,
    selectedWorkspace: workspace,
    isRunning: false,
    api,
    setSnapshot,
    focusComposer,
    openSettings,
    updateSnapshot,
    allowTreeCommand: false,
    immediateCommandMode: "prefill",
    onSelectModelOption: (nextProvider, nextModelId) => {
      setProvider(nextProvider);
      setModelId(nextModelId);
    },
    onSelectThinkingOption: setThinkingLevel,
    onSelectLoginProvider: (providerId) => {
      if (!api || !workspace) {
        return;
      }
      void updateSnapshot(setSnapshot, () => api.loginProvider(workspace.id, providerId)).catch(
        (error: unknown) => {
          console.error("[renderer] loginProvider failed", error);
        },
      );
    },
    onSelectLogoutProvider: (providerId) => {
      if (!api || !workspace) {
        return;
      }
      void updateSnapshot(setSnapshot, () => api.logoutProvider(workspace.id, providerId)).catch(
        (error: unknown) => {
          console.error("[renderer] logoutProvider failed", error);
        },
      );
    },
  });

  const enableMentionExtension = useCallback(
    (filePath: string) => {
      if (!api || !workspace) {
        return Promise.resolve();
      }
      return updateSnapshot(setSnapshot, () =>
        api.setExtensionEnabled(workspace.id, filePath, true),
      ).then(() => undefined);
    },
    [api, setSnapshot, workspace],
  );

  const mentionMenu = useMentionMenu({
    composerDraft: prompt,
    setComposerDraft: setPrompt,
    composerRef,
    workspaceId: workspace?.id,
    runtime,
    api,
    onEnableExtension: enableMentionExtension,
  });

  const startThread = useCallback(() => {
    // The prompt clears only once the thread exists, so a second Enter or click before
    // then would otherwise start the same thread again (a worktree start takes seconds).
    const generation = surfaceGenerationRef.current;
    if (!api || startingGenerationRef.current === generation) {
      return;
    }
    if (!rootWorkspaceId || (!prompt.trim() && attachments.length === 0)) {
      return;
    }
    if (modelOnboarding.requiresModelSelection) {
      return;
    }
    const treeCommand = parseTreeComposerCommand(prompt);
    if (treeCommand?.type === "error") {
      setComposerError(treeCommand.message);
      return;
    }
    if (treeCommand?.type === "tree") {
      setComposerError("/tree is only available inside an existing session.");
      return;
    }
    // Several models: each chat works in its own worktree so their edits never collide.
    const comparing = compareModels.filter(
      (entry) => !(entry.provider === resolvedProvider && entry.modelId === resolvedModelId),
    );
    const input: StartThreadInput = {
      rootWorkspaceId,
      environment: comparing.length > 0 ? "worktree" : environment,
      prompt,
      attachments,
      provider: resolvedProvider,
      modelId: resolvedModelId,
      thinkingLevel: resolvedThinkingLevel,
      ...(Object.keys(extensionFlags).length > 0 ? { extensionFlags } : {}),
    };
    startingGenerationRef.current = generation;
    recordSentPrompt(prompt);
    void updateSnapshot(setSnapshot, async () => {
      const first = await api.startThread(input);
      let last = first;
      for (const entry of comparing) {
        last = await api.startThread({ ...input, provider: entry.provider, modelId: entry.modelId });
      }
      return last;
    })
      .then(() => {
        if (surfaceGenerationRef.current !== generation) {
          return;
        }
        setPrompt("");
        setAttachments([]);
        setProvider(undefined);
        setModelId(undefined);
        setCompareModels([]);
        setThinkingLevel(undefined);
        setExtensionFlagEdits({});
        setEnvironment("local");
      })
      .catch((error: unknown) => {
        setComposerError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (startingGenerationRef.current === generation) {
          startingGenerationRef.current = undefined;
        }
      });
  }, [
    api,
    attachments,
    environment,
    extensionFlags,
    modelOnboarding.requiresModelSelection,
    prompt,
    recordSentPrompt,
    resolvedModelId,
    resolvedProvider,
    resolvedThinkingLevel,
    rootWorkspaceId,
    setSnapshot,
  ]);

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = extractImageFilesFromClipboardData(event.clipboardData);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      addAttachments(files);
    },
    [addAttachments],
  );

  const handleComposerDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const files = extractFilesFromDataTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }
      addAttachments(files);
    },
    [addAttachments],
  );

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        handleClipboardImageShortcut(
          event,
          api?.readClipboardImage,
          appendAttachment,
          setComposerError,
        )
      ) {
        return;
      }

      if (mentionMenu.handleMentionKeyDown(event)) {
        return;
      }

      if (slashMenu.handleSlashKeyDown(event)) {
        return;
      }

      if (handlePromptHistoryKeyDown(event, prompt, updatePrompt)) {
        return;
      }

      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }

      event.preventDefault();
      if (!prompt.trim() && attachments.length === 0) {
        return;
      }
      if (modelOnboarding.requiresModelSelection) {
        return;
      }

      startThread();
    },
    [
      api,
      appendAttachment,
      attachments.length,
      handlePromptHistoryKeyDown,
      mentionMenu,
      modelOnboarding.requiresModelSelection,
      prompt,
      slashMenu,
      startThread,
      updatePrompt,
    ],
  );

  useEffect(() => {
    if (rootWorkspaceOptions.length === 0) {
      setPendingWorkspaceId("");
      setRootWorkspaceId("");
      setEnvironment("local");
      setAttachments([]);
      return;
    }
    setRootWorkspaceId((current) =>
      rootWorkspaceOptions.some((w) => w.id === current)
        ? current
        : current || rootWorkspaceOptions[0]?.id || "",
    );
  }, [rootWorkspaceOptions]);

  // A folder opened while New chat is on screen (Windows or Mac picker) is where the next chat
  // starts; without this the composer kept pointing at the previously chosen folder.
  const knownWorkspaceIdsRef = useRef<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    if (!snapshot) {
      return;
    }
    const known = knownWorkspaceIdsRef.current;
    knownWorkspaceIdsRef.current = new Set(snapshot.workspaces.map((workspace) => workspace.id));
    if (!known || snapshot.activeView !== "new-thread") {
      return;
    }
    const opened = snapshot.workspaces.find((workspace) => !known.has(workspace.id));
    if (opened) {
      setPendingWorkspaceId(opened.id);
    }
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot || !pendingWorkspaceId) {
      return;
    }
    const nextRootWorkspaceId = resolveRepoWorkspaceId(snapshot.workspaces, pendingWorkspaceId);
    if (!nextRootWorkspaceId || !rootWorkspaceOptions.some((w) => w.id === nextRootWorkspaceId)) {
      return;
    }
    setRootWorkspaceId(nextRootWorkspaceId);
    setPendingWorkspaceId("");
  }, [pendingWorkspaceId, rootWorkspaceOptions, snapshot]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    if (
      snapshot.activeView === "new-thread" &&
      previousActiveViewRef.current !== "new-thread" &&
      !openedInAppRef.current
    ) {
      const nextRootWorkspaceId = resolveRepoWorkspaceId(
        snapshot.workspaces,
        selectedWorkspace?.id,
      );
      if (nextRootWorkspaceId) {
        setRootWorkspaceId(nextRootWorkspaceId);
      }
    }
    if (snapshot.activeView === "new-thread") openedInAppRef.current = false;
    previousActiveViewRef.current = snapshot.activeView;
  }, [selectedWorkspace?.id, snapshot]);

  return useMemo(
    () => ({
      composerRef,
      workspace,
      runtime,
      rootWorkspaceId,
      environment,
      prompt,
      attachments,
      composerError,
      resolvedProvider,
      resolvedModelId,
      resolvedThinkingLevel,
      extensionFlags,
      setExtensionFlag,
      modelOnboarding,
      slashMenu,
      mentionMenu,
      setPrompt,
      setEnvironment,
      setProvider,
      setModelId,
      compareModels,
      toggleCompareModel,
      setThinkingLevel,
      setPendingWorkspaceId,
      selectWorkspace,
      addAttachments,
      removeAttachment,
      appendAttachment,
      handleComposerPaste,
      handleComposerDrop,
      handleComposerKeyDown,
      startThread,
      openSurface,
      resetSurface,
      setComposerError,
    }),
    [
      workspace,
      runtime,
      rootWorkspaceId,
      environment,
      prompt,
      attachments,
      composerError,
      resolvedProvider,
      resolvedModelId,
      resolvedThinkingLevel,
      extensionFlags,
      setExtensionFlag,
      modelOnboarding,
      slashMenu,
      mentionMenu,
      compareModels,
      toggleCompareModel,
      selectWorkspace,
      addAttachments,
      removeAttachment,
      appendAttachment,
      handleComposerPaste,
      handleComposerDrop,
      handleComposerKeyDown,
      startThread,
      openSurface,
      resetSurface,
    ],
  );
}
