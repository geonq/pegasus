import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { SessionExtensionUiStateRecord } from "../../../contracts/desktop-state";
import {
  isSessionPermission,
  sessionPermissionStatusKey,
  type SessionPermission,
} from "../../../contracts/session-permission";
import { ChatIcon, CheckIcon, PencilIcon, SearchIcon, TerminalIcon } from "../../ui/icons";

const PERMISSION_OPTIONS: readonly {
  readonly value: SessionPermission;
  readonly label: string;
  readonly description: string;
  readonly icon: ReactNode;
}[] = [
  {
    value: "plan",
    label: "Plan",
    description: "Reads and plans, changes nothing",
    icon: <SearchIcon />,
  },
  {
    value: "ask",
    label: "Ask first",
    description: "Asks before each change or command",
    icon: <ChatIcon />,
  },
  {
    value: "edits",
    label: "Accept edits",
    description: "Changes files freely, asks before commands",
    icon: <PencilIcon />,
  },
  {
    value: "full",
    label: "Full access",
    description: "Changes files and runs commands without asking",
    icon: <TerminalIcon />,
  },
];

/**
 * The permission the Pi extension reports for this chat: a level, `null` when the status is not
 * one Pegasus knows, or `undefined` when permissions do not apply (no Pi workflow for its folder).
 */
export function sessionPermissionFromUi(
  uiState?: SessionExtensionUiStateRecord,
): SessionPermission | null | undefined {
  const status = uiState?.statuses.find((entry) => entry.key === sessionPermissionStatusKey);
  if (!status) return undefined;
  const text = status.text.trim();
  return isSessionPermission(text) ? text : null;
}

/**
 * A chat reports its permission once its Pi session has started. Until then the picker still
 * shows when the folder's extensions provide `/permissions`.
 */
export function runtimeHasPermissions(runtime: RuntimeSnapshot | undefined): boolean {
  return Boolean(
    runtime?.extensions.some(
      (extension) => extension.enabled && extension.commands.includes("permissions"),
    ),
  );
}

/** Changes a chat's permission; the new level arrives with the next app state from main. */
export function sessionPermissionSetter(
  workspaceId: string | undefined,
  sessionId: string | undefined,
): (permission: SessionPermission) => void {
  return (permission) => {
    if (!workspaceId || !sessionId) return;
    window.piApp
      ?.setSessionPermission(workspaceId, sessionId, permission)
      .catch((error: unknown) => {
        console.error("[renderer] setSessionPermission failed", error);
      });
  };
}

interface PermissionSelectorProps {
  readonly permission: SessionPermission | null;
  readonly disabled?: boolean;
  readonly onSetPermission: (permission: SessionPermission) => void;
}

export function PermissionSelector({
  permission,
  disabled,
  onSetPermission,
}: PermissionSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const active = PERMISSION_OPTIONS.find((option) => option.value === permission);

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <span className="model-selector" ref={containerRef}>
      <span className="model-selector__anchor">
        <button
          aria-expanded={open}
          aria-haspopup="true"
          aria-label={`Permissions: ${active?.label ?? "not set"}`}
          className="model-selector__badge"
          type="button"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          {active?.icon}
          <span>{active?.label ?? "Permissions"}</span>
        </button>
        {open ? (
          <div className="model-selector__dropdown permission-menu" onWheel={(event) => event.stopPropagation()}>
            <div className="model-selector__group-title">Permissions</div>
            {PERMISSION_OPTIONS.map((option) => {
              const isActive = option.value === permission;
              return (
                <button
                  aria-pressed={isActive}
                  className={`model-selector__item permission-menu__item${isActive ? " model-selector__item--active" : ""}`}
                  key={option.value}
                  type="button"
                  onClick={() => {
                    if (!isActive) onSetPermission(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="permission-menu__icon">{option.icon}</span>
                  <span className="permission-menu__text">
                    <span className="model-selector__item-label">{option.label}</span>
                    <span className="model-selector__item-meta">{option.description}</span>
                  </span>
                  {isActive ? <CheckIcon /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </span>
    </span>
  );
}
