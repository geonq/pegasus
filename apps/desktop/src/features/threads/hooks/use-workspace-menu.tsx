import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  DesktopAppState,
  WorkspaceRecord,
  WorktreeRecord,
} from "../../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import type {
  WorkspaceFolderCreateResult,
  WorkspaceFolderDevice,
  WorkspaceFolderOpenResult,
} from "../../../../contracts/workspace-folders";

interface UseWorkspaceMenuParams {
  readonly api: PiDesktopApi | undefined;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly descriptions: Readonly<Record<string, string>>;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
}

export interface WorkspaceMenuState {
  readonly workspaceMenuId: string | null;
  readonly descriptions: Readonly<Record<string, string>>;
  readonly workspaceRenameId: string | null;
  readonly workspaceRenameDraft: string;
  readonly setWorkspaceRenameDraft: Dispatch<SetStateAction<string>>;
  readonly workspaceDescriptionDraft: string;
  readonly setWorkspaceDescriptionDraft: Dispatch<SetStateAction<string>>;
  readonly folderPickerOpen: boolean;
  readonly folderPickerCreateMode: boolean;
  readonly folderPickerDevice: WorkspaceFolderDevice;
  readonly setFolderPickerDevice: Dispatch<SetStateAction<WorkspaceFolderDevice>>;
  readonly closeFolderPicker: () => void;
  readonly handleFolderOpenResult: (result: WorkspaceFolderOpenResult) => Promise<boolean>;
  readonly handleWindowsFolderCreated: (
    result: Extract<WorkspaceFolderCreateResult, { device: "windows" }>,
  ) => Promise<void>;
  readonly workspaceMenuWrapRef: RefObject<HTMLSpanElement | null>;
  readonly workspaceRenamePanelRef: RefObject<HTMLFormElement | null>;
  readonly workspaceRenameInputRef: RefObject<HTMLInputElement | null>;
  readonly workspaceDescriptionInputRef: RefObject<HTMLTextAreaElement | null>;
  readonly addWorkspace: (createNew?: boolean) => void;
  readonly openWorkspaceMenu: (workspaceId: string) => void;
  readonly closeWorkspaceMenu: () => void;
  readonly startRename: (workspace: WorkspaceRecord) => void;
  readonly submitRename: (workspace: WorkspaceRecord) => void;
  readonly cancelRename: () => void;
  readonly removeWorkspace: (workspace: WorkspaceRecord) => void;
  readonly createWorktree: (
    workspaceId: string,
    fromSessionWorkspaceId?: string,
    fromSessionId?: string,
  ) => void;
  readonly removeWorktree: (workspaceId: string, worktree: WorktreeRecord) => void;
  readonly selectWorkspace: (workspaceId: string) => void;
  readonly runWorkspaceMenuAction: (
    event: ReactMouseEvent<HTMLElement>,
    action: () => void,
  ) => void;
}

export function useWorkspaceMenu(params: UseWorkspaceMenuParams): WorkspaceMenuState {
  const { api, workspaces, descriptions, setSnapshot, updateSnapshot } = params;

  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [workspaceRenameId, setWorkspaceRenameId] = useState<string | null>(null);
  const [workspaceRenameDraft, setWorkspaceRenameDraft] = useState("");
  const [workspaceDescriptionDraft, setWorkspaceDescriptionDraft] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerCreateMode, setFolderPickerCreateMode] = useState(false);
  const [folderPickerDevice, setFolderPickerDevice] = useState<WorkspaceFolderDevice>("windows");
  // A freshly added project opens the editor on its description: every project gets one.
  const [focusDescription, setFocusDescription] = useState(false);

  const workspaceMenuWrapRef = useRef<HTMLSpanElement | null>(null);
  const workspaceRenamePanelRef = useRef<HTMLFormElement | null>(null);
  const workspaceRenameInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceDescriptionInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus/select rename input when rename starts
  useEffect(() => {
    if (!workspaceRenameId) {
      return undefined;
    }

    const input = focusDescription
      ? workspaceDescriptionInputRef.current
      : workspaceRenameInputRef.current;
    input?.focus();
    input?.select();
    return undefined;
  }, [workspaceRenameId, focusDescription]);

  // Click-outside / Escape handler for workspace menu and rename panel
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const menuContains = workspaceMenuWrapRef.current?.contains(target) ?? false;
      const renamePanelContains = workspaceRenamePanelRef.current?.contains(target) ?? false;
      if (!menuContains && !renamePanelContains) {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuId(null);
        setWorkspaceRenameId(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const openWorkspaceMenu = (workspaceId: string) => {
    setWorkspaceMenuId((current) => (current === workspaceId ? null : workspaceId));
  };

  const closeWorkspaceMenu = () => {
    setWorkspaceMenuId(null);
  };

  const startRename = (workspace: WorkspaceRecord, isNew = false) => {
    setWorkspaceMenuId(null);
    setWorkspaceRenameId(workspace.id);
    setWorkspaceRenameDraft(workspace.name);
    setWorkspaceDescriptionDraft(descriptions[workspace.id] ?? "");
    setFocusDescription(isNew);
  };

  const cancelRename = () => {
    setWorkspaceRenameId(null);
    setWorkspaceRenameDraft("");
    setWorkspaceDescriptionDraft("");
  };

  const submitRename = (workspace: WorkspaceRecord) => {
    const nextName = workspaceRenameDraft.trim();
    const nextDescription = workspaceDescriptionDraft.trim();
    setWorkspaceMenuId(null);
    cancelRename();
    if (!api) {
      return;
    }
    if (nextName && nextName !== workspace.name) {
      void updateSnapshot(setSnapshot, () => api.renameWorkspace(workspace.id, nextName)).catch(
        (error: unknown) => {
          console.error("[renderer] renameWorkspace failed", error);
        },
      );
    }
    if (nextDescription !== (descriptions[workspace.id] ?? "")) {
      void updateSnapshot(setSnapshot, () =>
        api.setWorkspaceDescription(workspace.id, nextDescription),
      ).catch((error: unknown) => {
        console.error("[renderer] setWorkspaceDescription failed", error);
      });
    }
  };

  const addWorkspace = (createNew = false) => {
    if (!api) {
      return;
    }
    // The in-app picker browses folders that are already open; with none open it has no locations,
    // so the very first folder (and any folder it cannot reach) comes from the system dialog.
    if (api.workspaceFolders && workspaces.length > 0) {
      setWorkspaceMenuId(null);
      setFolderPickerCreateMode(createNew);
      setFolderPickerOpen(true);
      return;
    }
    const known = new Set(workspaces.map((workspace) => workspace.id));
    void updateSnapshot(setSnapshot, () => api.pickWorkspace(createNew))
      .then((state) => {
        const added = state.workspaces.find((workspace) => !known.has(workspace.id));
        if (added) startRename(added, true);
      })
      .catch((error: unknown) => {
        console.error("[renderer] pickWorkspace failed", error);
      });
  };

  const removeWorkspace = (workspace: WorkspaceRecord) => {
    const confirmed = window.confirm(
      `Remove ${workspace.name} from Pegasus? This will not delete any files.`,
    );
    setWorkspaceMenuId(null);
    setWorkspaceRenameId(null);
    if (!confirmed || !api) {
      return;
    }
    void updateSnapshot(setSnapshot, () => api.removeWorkspace(workspace.id)).catch(
      (error: unknown) => {
        console.error("[renderer] removeWorkspace failed", error);
      },
    );
  };

  const closeFolderPicker = () => {
    setFolderPickerOpen(false);
    setFolderPickerCreateMode(false);
  };

  const handleFolderOpenResult = async (result: WorkspaceFolderOpenResult) => {
    if (result.device === "windows") {
      const known = new Set(workspaces.map((workspace) => workspace.id));
      await updateSnapshot(setSnapshot, async () => result.state);
      const added = result.state.workspaces.find(
        (workspace) => workspace.id === result.workspaceId && !known.has(workspace.id),
      );
      if (added) startRename(added, true);
      return true;
    }

    // A Mac folder opened as a Pi project arrives with the state that registered it.
    if (result.state) {
      const state = result.state;
      await updateSnapshot(setSnapshot, async () => state);
      return true;
    }

    const workspaceId = result.workspaceId;
    if (api && workspaceId && workspaces.some((workspace) => workspace.id === workspaceId)) {
      await updateSnapshot(setSnapshot, () => api.selectWorkspace(workspaceId));
      return true;
    }

    return false;
  };

  const handleWindowsFolderCreated = async (
    result: Extract<WorkspaceFolderCreateResult, { device: "windows" }>,
  ) => {
    const known = new Set(workspaces.map((workspace) => workspace.id));
    await updateSnapshot(setSnapshot, async () => result.state);
    const added = result.state.workspaces.find(
      (workspace) => workspace.id === result.workspaceId && !known.has(workspace.id),
    );
    if (added) startRename(added, true);
  };

  const createWorktree = (
    workspaceId: string,
    fromSessionWorkspaceId?: string,
    fromSessionId?: string,
  ) => {
    setWorkspaceMenuId(null);
    if (!api) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.createWorktree({ workspaceId, fromSessionWorkspaceId, fromSessionId }),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
  };

  const removeWorktree = (workspaceId: string, worktree: WorktreeRecord) => {
    const confirmed = window.confirm(
      `Remove worktree ${worktree.name}? This removes the git worktree from disk.`,
    );
    if (!confirmed || !api) {
      return;
    }
    void updateSnapshot(setSnapshot, () =>
      api.removeWorktree({ workspaceId, worktreeId: worktree.id }),
    ).catch((error: unknown) => {
      console.error("[renderer] updateSnapshot failed", error);
    });
  };

  const selectWorkspace = (workspaceId: string) => {
    if (!api) {
      return;
    }
    void updateSnapshot(setSnapshot, () => api.selectWorkspace(workspaceId)).catch(
      (error: unknown) => {
        console.error("[renderer] selectWorkspace failed", error);
      },
    );
  };

  const runWorkspaceMenuAction = (event: ReactMouseEvent<HTMLElement>, action: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    setWorkspaceMenuId(null);
    action();
  };

  return {
    workspaceMenuId,
    descriptions,
    workspaceRenameId,
    workspaceRenameDraft,
    setWorkspaceRenameDraft,
    workspaceDescriptionDraft,
    setWorkspaceDescriptionDraft,
    folderPickerOpen,
    folderPickerCreateMode,
    folderPickerDevice,
    setFolderPickerDevice,
    closeFolderPicker,
    handleFolderOpenResult,
    handleWindowsFolderCreated,
    workspaceMenuWrapRef,
    workspaceRenamePanelRef,
    workspaceRenameInputRef,
    workspaceDescriptionInputRef,
    addWorkspace,
    openWorkspaceMenu,
    closeWorkspaceMenu,
    startRename,
    submitRename,
    cancelRename,
    removeWorkspace,
    createWorktree,
    removeWorktree,
    selectWorkspace,
    runWorkspaceMenuAction,
  };
}
