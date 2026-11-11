import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  WorkspaceFolderAdapters,
  WorkspaceFolderCreateResult,
  WorkspaceFolderDevice,
  WorkspaceFolderListing,
  WorkspaceFolderOpenResult,
  WorkspaceFolderRoot,
} from "../../../contracts/workspace-folders";
import { ArrowUpIcon, ChevronRightIcon, CloseIcon, FolderIcon, PlusIcon } from "../../ui/icons";
import "./workspace-folder-picker.css";

interface WorkspaceFolderPickerProps {
  readonly adapters: WorkspaceFolderAdapters;
  readonly device: WorkspaceFolderDevice;
  readonly initialCreateMode: boolean;
  readonly onDeviceChange: (device: WorkspaceFolderDevice) => void;
  readonly onClose: () => void;
  readonly onOpenResult: (result: WorkspaceFolderOpenResult) => Promise<boolean>;
  readonly onWindowsFolderCreated: (
    result: Extract<WorkspaceFolderCreateResult, { device: "windows" }>,
  ) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Folder request failed.";
}

function trapPickerFocus(event: ReactKeyboardEvent<HTMLDivElement>, dialog: HTMLDivElement | null) {
  if (!dialog) return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.getAttribute("aria-hidden"));
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

export function WorkspaceFolderPicker({
  adapters,
  device,
  initialCreateMode,
  onDeviceChange,
  onClose,
  onOpenResult,
  onWindowsFolderCreated,
}: WorkspaceFolderPickerProps) {
  const [roots, setRoots] = useState<readonly WorkspaceFolderRoot[]>([]);
  const [rootId, setRootId] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [listing, setListing] = useState<WorkspaceFolderListing | null>(null);
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [loadingListing, setLoadingListing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createMode, setCreateMode] = useState(initialCreateMode);
  const [folderName, setFolderName] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listingRequest = useRef(0);
  const adapter = device === "windows" ? adapters.windows : adapters.mac;
  const currentRoot = roots.find((root) => root.id === rootId);

  useEffect(() => {
    if (!initialCreateMode) {
      dialogRef.current
        ?.querySelector<HTMLButtonElement>("[data-folder-picker-focus='true']")
        ?.focus();
    }
  }, [initialCreateMode]);

  useEffect(() => {
    if (createMode && currentRoot?.canCreate && !loadingRoots) {
      dialogRef.current
        ?.querySelector<HTMLInputElement>("[data-folder-picker-name='true']")
        ?.focus();
    }
  }, [createMode, currentRoot?.canCreate, loadingRoots]);

  useEffect(() => {
    let cancelled = false;
    setRoots([]);
    setRootId("");
    setRelativePath("");
    setListing(null);
    setError("");
    setNotice("");

    if (!adapter) {
      setLoadingRoots(false);
      return () => {
        cancelled = true;
      };
    }

    setLoadingRoots(true);
    void adapter
      .listRoots()
      .then((nextRoots) => {
        if (cancelled) return;
        setRoots(nextRoots);
        setRootId(nextRoots.find((root) => root.canCreate)?.id ?? nextRoots[0]?.id ?? "");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingRoots(false);
      });

    return () => {
      cancelled = true;
    };
  }, [adapter, device]);

  useEffect(() => {
    if (!adapter || !rootId) {
      setListing(null);
      setLoadingListing(false);
      return undefined;
    }

    const request = ++listingRequest.current;
    setListing(null);
    setLoadingListing(true);
    setError("");
    void adapter
      .list(rootId, relativePath || undefined)
      .then((nextListing) => {
        if (listingRequest.current === request) setListing(nextListing);
      })
      .catch((cause: unknown) => {
        if (listingRequest.current === request) setError(errorMessage(cause));
      })
      .finally(() => {
        if (listingRequest.current === request) setLoadingListing(false);
      });

    return () => {
      listingRequest.current += 1;
    };
  }, [adapter, device, relativePath, rootId]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapPickerFocus(event, dialogRef.current);
      return;
    }
    if (event.key === "Escape" && !pending) {
      event.preventDefault();
      onClose();
    }
  };

  const changeDevice = (nextDevice: WorkspaceFolderDevice) => {
    if (nextDevice === device || (nextDevice === "mac" && !adapters.mac)) return;
    onDeviceChange(nextDevice);
  };

  const openCurrentFolder = async () => {
    if (!adapter || !rootId || !listing || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await adapter.open(rootId, listing.relativePath);
      const selected = await onOpenResult(result);
      if (selected) onClose();
      else {
        setNotice(
          device === "mac" && listing.relativePath
            ? `Folders under ${currentRoot?.label ?? "this location"} cannot be opened as projects yet. Pick your Mac home as the location and browse to the same folder.`
            : "Open a folder inside this location; the location itself cannot be a project.",
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const createFolder = async () => {
    const name = folderName.trim();
    if (!adapter || !currentRoot || !listing || !name || !currentRoot.canCreate || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await adapter.create(currentRoot.id, listing.relativePath, name);
      if (result.device === "windows") {
        await onWindowsFolderCreated(result);
        onClose();
      } else {
        setRelativePath(result.relativePath);
        setCreateMode(false);
        setFolderName("");
        setNotice("Folder created on the Mac. Open it to make it a project.");
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="tree-modal-backdrop"
      data-testid="workspace-folder-picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        aria-labelledby="workspace-folder-picker-title"
        aria-modal="true"
        className="tree-modal workspace-folder-picker"
        data-testid="workspace-folder-picker"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="tree-modal__header">
          <div>
            <div className="tree-modal__eyebrow">Project folders</div>
            <h2 className="tree-modal__title" id="workspace-folder-picker-title">
              Open a folder
            </h2>
          </div>
          <button
            aria-label="Close folder picker"
            className="tree-modal__close"
            disabled={pending}
            type="button"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="workspace-folder-picker__scope">
          <div aria-label="Folder location" className="sidebar__grouping" role="group">
            <button
              aria-pressed={device === "windows"}
              data-folder-picker-focus="true"
              type="button"
              onClick={() => changeDevice("windows")}
            >
              Windows
            </button>
            <button
              aria-pressed={device === "mac"}
              disabled={!adapters.mac}
              type="button"
              onClick={() => changeDevice("mac")}
            >
              Mac
            </button>
          </div>
          {!adapters.mac ? (
            <span className="workspace-folder-picker__muted">
              Mac folder browsing is unavailable for this connection.
            </span>
          ) : null}
        </div>

        {error ? (
          <div
            className="tree-modal__error error-banner"
            data-testid="workspace-folder-error"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        {notice ? (
          <div
            className="workspace-folder-picker__notice"
            data-testid="workspace-folder-notice"
            role="status"
          >
            {notice}
          </div>
        ) : null}

        <div className="workspace-folder-picker__browser">
          <label className="workspace-folder-picker__root">
            <span>Location</span>
            <select
              aria-label="Folder location root"
              disabled={loadingRoots || roots.length === 0 || pending}
              value={rootId}
              onChange={(event) => {
                setRootId(event.currentTarget.value);
                setRelativePath("");
                setNotice("");
              }}
            >
              {roots.length === 0 ? <option value="">No locations</option> : null}
              {roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.label}
                </option>
              ))}
            </select>
          </label>

          {currentRoot ? (
            <div className="workspace-folder-picker__path" title={listing?.relativePath ?? ""}>
              <span>{currentRoot.label}</span>
              {listing?.relativePath ? (
                <>
                  <ChevronRightIcon />
                  <code>{listing.relativePath}</code>
                </>
              ) : null}
              {listing?.parentRelativePath !== undefined ? (
                <button
                  aria-label="Go to parent folder"
                  className="workspace-folder-picker__up"
                  disabled={pending || loadingListing}
                  type="button"
                  onClick={() => {
                    setRelativePath(listing.parentRelativePath ?? "");
                    setNotice("");
                  }}
                >
                  <ArrowUpIcon />
                  <span>Up</span>
                </button>
              ) : null}
            </div>
          ) : null}

          <div aria-label="Folders" className="workspace-folder-picker__list" role="list">
            {loadingRoots || loadingListing ? (
              <div className="tree-modal__loading" role="status">
                Loading folders…
              </div>
            ) : null}
            {!loadingRoots && !loadingListing && roots.length === 0 && !error ? (
              <div className="tree-modal__empty">
                No folder locations are available on {device === "windows" ? "Windows" : "Mac"}.
              </div>
            ) : null}
            {!loadingListing && listing?.folders.length === 0 ? (
              <div className="tree-modal__empty">This folder has no subfolders.</div>
            ) : null}
            {listing?.folders.map((folder) => (
              <div key={folder.relativePath} role="listitem">
                <button
                  className="workspace-folder-picker__folder"
                  disabled={pending}
                  type="button"
                  onClick={() => {
                    setRelativePath(folder.relativePath);
                    setNotice("");
                  }}
                >
                  <FolderIcon />
                  <span>{folder.name}</span>
                  <ChevronRightIcon />
                </button>
              </div>
            ))}
          </div>
          {listing?.truncated ? (
            <div className="workspace-folder-picker__muted">
              This list is limited. Open a subfolder to narrow the results.
            </div>
          ) : null}

          {createMode ? (
            <form
              className="workspace-folder-picker__create"
              onSubmit={(event) => {
                event.preventDefault();
                void createFolder().catch((cause: unknown) => setError(errorMessage(cause)));
              }}
            >
              <label>
                <span>New folder name</span>
                <input
                  autoComplete="off"
                  data-folder-picker-name="true"
                  disabled={pending || !currentRoot?.canCreate}
                  value={folderName}
                  onChange={(event) => setFolderName(event.currentTarget.value)}
                />
              </label>
              <button
                className="button button--ghost workspace-folder-picker__create-cancel"
                disabled={pending}
                type="button"
                onClick={() => setCreateMode(false)}
              >
                Cancel
              </button>
              <button
                className="button button--ghost workspace-folder-picker__create-submit"
                disabled={pending || !currentRoot?.canCreate || !folderName.trim()}
                type="submit"
              >
                Create folder
              </button>
              {!currentRoot?.canCreate ? (
                <span className="workspace-folder-picker__muted">
                  Creating folders is unavailable at this location.
                </span>
              ) : null}
            </form>
          ) : null}
        </div>

        <div className="tree-modal__footer workspace-folder-picker__footer">
          <span className="workspace-folder-picker__muted">
            {device === "windows"
              ? "Windows folders become project folders; no chat is created."
              : "Mac folders become project folders; Pi works in them on the Mac."}
          </span>
          <div className="tree-modal__actions">
            {!createMode ? (
              <button
                className="button button--ghost workspace-folder-picker__new"
                disabled={pending || !currentRoot?.canCreate || !listing}
                type="button"
                onClick={() => setCreateMode(true)}
              >
                <PlusIcon />
                New folder
              </button>
            ) : null}
            <button
              className="button button--ghost workspace-folder-picker__open"
              disabled={pending || loadingListing || !listing}
              type="button"
              onClick={() =>
                void openCurrentFolder().catch((cause: unknown) => setError(errorMessage(cause)))
              }
            >
              Open folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
