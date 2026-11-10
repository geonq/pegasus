import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  buildModelOptions,
  MODEL_OPTIONS_EMPTY_TITLE,
  THINKING_OPTIONS,
  type ComposerModelOption,
} from "./composer-commands";
import { CheckIcon, ProviderIcon, ReasoningIcon } from "../../ui/icons";
import { ProviderStatusBadge, useProviderStatuses } from "../usage/account-state";

/** The provider logo stands in for the brand, so labels drop "Claude", "GPT", "(Claude Code)" etc. */
const withoutBrand = (label: string) =>
  label
    .replace(/\(Claude Code\)/i, "")
    .replace(/\b(Claude Code|Claude|OpenAI|Codex|GPT)\b[\s-]*/gi, "")
    .trim();
const accountHeading = (providerId: string, label: string) =>
  providerId === "antigravity"
    ? "AGY"
    : (
        withoutBrand(label)
          .replace(/^[\s·:-]+/, "")
          .trim() || label
      ).toLocaleUpperCase();
const modelName = (option: ComposerModelOption) =>
  withoutBrand(option.label.split(" · ").at(-1) ?? "");

interface ModelSelectorProps {
  readonly runtime: RuntimeSnapshot | undefined;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly disabled?: boolean;
  readonly dropdownPlacement?: "above" | "below";
  readonly showEmptyModelControl?: boolean;
  readonly unselectedModelLabel?: string;
  readonly emptyModelLabel?: string;
  readonly emptyModelTitle?: string;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  /** New chats only: Shift-click adds or removes a model that also gets the prompt. */
  readonly compareModels?: readonly ComparedModel[];
  readonly onToggleCompareModel?: (provider: string, modelId: string) => void;
}

export interface ComparedModel {
  readonly provider: string;
  readonly modelId: string;
}

type OpenDropdown = "none" | "model" | "thinking";

export function ModelSelector({
  runtime,
  provider,
  modelId,
  thinkingLevel,
  disabled,
  dropdownPlacement = "above",
  showEmptyModelControl = false,
  unselectedModelLabel = "Choose model",
  emptyModelLabel = "Choose model",
  emptyModelTitle = MODEL_OPTIONS_EMPTY_TITLE,
  onSetModel,
  onSetThinking,
  compareModels,
  onToggleCompareModel,
}: ModelSelectorProps) {
  const [open, setOpen] = useState<OpenDropdown>("none");
  const [modelFilter, setModelFilter] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const statuses = useProviderStatuses();

  const closeDropdown = () => {
    setOpen("none");
    setModelFilter("");
  };

  const modelOptions = useMemo(() => buildModelOptions(runtime), [runtime]);
  const deferredFilter = useDeferredValue(modelFilter);
  const filteredModels = useMemo(() => {
    if (!deferredFilter) return modelOptions;
    const q = deferredFilter.toLowerCase();
    return modelOptions.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) ||
        opt.description.toLowerCase().includes(q) ||
        opt.providerId.toLowerCase().includes(q),
    );
  }, [modelOptions, deferredFilter]);

  const groupedModels = useMemo(() => groupByProvider(filteredModels), [filteredModels]);
  const hasAvailableModelOptions = modelOptions.length > 0;
  const hasModelControl = Boolean(provider && modelId) || hasAvailableModelOptions;
  const shouldRenderModelControl = hasModelControl || showEmptyModelControl;
  const activeModel = modelOptions.find(
    (option) => option.providerId === provider && option.modelId === modelId,
  );
  // Effort levels come from the model itself (Claude, Codex and Gemini alike); a model that reports none
  // gets no effort control. Unknown models (catalog not loaded yet) keep the full list.
  const modelLevels = runtime?.models.find(
    (model) => model.providerId === provider && model.modelId === modelId,
  )?.thinkingLevels;
  const thinkingOptions = modelLevels
    ? THINKING_OPTIONS.filter((option) => modelLevels.includes(option.value))
    : THINKING_OPTIONS;
  const modelBadgeLabel =
    provider && modelId ? (
      <>
        <ProviderIcon providerId={provider} modelId={modelId} />
        <span>{activeModel ? modelName(activeModel) : modelId}</span>
      </>
    ) : hasAvailableModelOptions ? (
      unselectedModelLabel
    ) : (
      emptyModelLabel
    );
  const noMatchingModels =
    hasAvailableModelOptions && modelFilter.trim().length > 0 && groupedModels.length === 0;

  useEffect(() => {
    if (open === "none") {
      return undefined;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeDropdown();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDropdown();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  if (!shouldRenderModelControl && !(thinkingLevel && thinkingOptions.length > 0)) {
    return null;
  }

  return (
    <span className="model-selector" ref={containerRef}>
      {shouldRenderModelControl ? (
        <span className="model-selector__anchor">
          <button
            aria-expanded={open === "model"}
            aria-haspopup="true"
            // The logo carries the brand visually; assistive tech gets the full name.
            aria-label={
              provider && modelId ? (activeModel?.label ?? `${provider} ${modelId}`) : undefined
            }
            className="model-selector__badge"
            type="button"
            disabled={disabled}
            onClick={() => (open === "model" ? closeDropdown() : setOpen("model"))}
          >
            {modelBadgeLabel}
          </button>
          {open === "model" ? (
            <div
              className={`model-selector__dropdown model-selector__dropdown--filtered ${dropdownPlacement === "below" ? "model-selector__dropdown--below" : ""}`}
              onWheel={(event) => event.stopPropagation()}
            >
              {/* The filter stays outside the scrolling list, so it needs no backdrop of its own. */}
              <div className="model-selector__filter">
                <input
                  aria-label="Filter models"
                  className="model-selector__filter-input"
                  autoComplete="off"
                  placeholder="Filter models…"
                  spellCheck={false}
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="model-selector__list">
                {groupedModels.map((group) => (
                  <div key={group.provider}>
                    <div className="model-selector__group-title">
                      <ProviderIcon providerId={group.provider} />
                      {accountHeading(
                        group.provider,
                        group.items[0]?.label.split(" · ").slice(0, -1).join(" · ") ?? "",
                      )}
                      <ProviderStatusBadge status={statuses.get(group.provider)} />
                    </div>
                    {group.items.map((option) => {
                      const isActive = option.providerId === provider && option.modelId === modelId;
                      const isCompared = Boolean(
                        compareModels?.some(
                          (entry) =>
                            entry.provider === option.providerId &&
                            entry.modelId === option.modelId,
                        ),
                      );
                      return (
                        <button
                          aria-label={option.label.split(" · ").at(-1)}
                          aria-pressed={isActive}
                          className={`model-selector__item${isActive ? " model-selector__item--active" : ""}${isCompared ? " model-selector__item--compared" : ""}`}
                          data-compared={isCompared ? "" : undefined}
                          key={`${option.providerId}:${option.modelId}`}
                          type="button"
                          onClick={(event) => {
                            // Shift-click: also run the prompt with this model; the menu stays open.
                            if (event.shiftKey && onToggleCompareModel && !isActive) {
                              onToggleCompareModel(option.providerId, option.modelId);
                              return;
                            }
                            if (!isActive) {
                              onSetModel(option.providerId, option.modelId);
                            }
                            closeDropdown();
                          }}
                        >
                          <ProviderIcon providerId={option.providerId} modelId={option.modelId} />
                          <span className="model-selector__item-label" title={option.modelId}>
                            {modelName(option)}
                          </span>
                          {isActive ? <CheckIcon /> : null}
                          {isCompared ? (
                            <span className="model-selector__compared" aria-label="Also runs">
                              +
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {onToggleCompareModel && groupedModels.length > 0 ? (
                  <div className="model-selector__hint">
                    Shift-click to also start this chat with another model, each in its own worktree.
                  </div>
                ) : null}
                {groupedModels.length === 0 ? (
                  <>
                    <div className="model-selector__group-title">
                      {noMatchingModels ? "No matching models" : emptyModelTitle}
                    </div>
                    {noMatchingModels ? (
                      <div className="model-selector__empty">Try a different filter.</div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </span>
      ) : null}
      {thinkingLevel && thinkingOptions.length > 0 ? (
        <span className="model-selector__anchor">
          <button
            aria-expanded={open === "thinking"}
            aria-haspopup="true"
            className="model-selector__badge"
            type="button"
            disabled={disabled}
            onClick={() => (open === "thinking" ? closeDropdown() : setOpen("thinking"))}
          >
            <ReasoningIcon />
            <span>
              {THINKING_OPTIONS.find((option) => option.value === thinkingLevel)?.label ??
                thinkingLevel}
            </span>
          </button>
          {open === "thinking" ? (
            <div
              className={`model-selector__dropdown ${dropdownPlacement === "below" ? "model-selector__dropdown--below" : ""}`}
              onWheel={(event) => event.stopPropagation()}
            >
              <div className="model-selector__group-title">Thinking Level</div>
              {thinkingOptions.map((option) => {
                const isActive = option.value === thinkingLevel;
                return (
                  <button
                    className={`model-selector__item model-selector__item--stacked${isActive ? " model-selector__item--active" : ""}`}
                    key={option.value}
                    type="button"
                    onClick={() => {
                      if (!isActive) {
                        onSetThinking(option.value);
                      }
                      closeDropdown();
                    }}
                  >
                    <span className="model-selector__item-label">{option.label}</span>
                    <span className="model-selector__item-meta">{option.description}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

interface ModelGroup {
  readonly provider: string;
  readonly items: readonly ComposerModelOption[];
}

function groupByProvider(options: readonly ComposerModelOption[]): readonly ModelGroup[] {
  const groups = new Map<string, ComposerModelOption[]>();
  for (const option of options) {
    const existing = groups.get(option.providerId);
    if (existing) {
      existing.push(option);
    } else {
      groups.set(option.providerId, [option]);
    }
  }
  return Array.from(groups.entries()).map(([provider, items]) => ({ provider, items }));
}
