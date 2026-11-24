import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { TranscriptTool } from "../../api/types";
import { Button, Icon, PressableScale, Spinner, Switch } from "../../ui";
import {
  hitSize,
  maxFontScale,
  radius,
  spacing,
  text,
  usePalette,
  type Palette,
} from "../../theme";
import { messageOf, useChatActions } from "./actions";
import {
  buildAnswer,
  describeAnswer,
  questionState,
  specAsksSomething,
  specFromToolInput,
  type ChecklistStatus,
  type UiNode,
} from "./wire";

type Draft = Record<string, string | readonly string[] | boolean | undefined>;

/**
 * An ask_user or show_ui call drawn as the interface it describes, like the desktop's
 * GenerativeUiToolItem. A question waiting on this run can be answered here; the card stays open
 * until the PC reports the answer in the tool's output, so nothing is dismissed optimistically.
 */
export function GenerativeUiCard({
  tool,
  workspaceId,
  sessionId,
  sessionRunning,
}: {
  readonly tool: TranscriptTool;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sessionRunning: boolean;
}) {
  const palette = usePalette();
  const spec = useMemo(
    () => specFromToolInput((tool as TranscriptTool & { readonly input?: unknown }).input),
    [tool],
  );
  const state = questionState(tool, sessionRunning);
  const actions = useChatActions(workspaceId, sessionId);
  const [draft, setDraft] = useState<Draft>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!spec) {
    // A spec the phone cannot read: show it as the plain step it is.
    return <Text style={[text.footnote, { color: palette.textMuted }]}>{tool.label}</Text>;
  }

  const open = state.kind === "open";
  const asks = specAsksSomething(spec);
  const set = (id: string, value: string | readonly string[] | boolean) => {
    setDraft((current) => ({ ...current, [id]: value }));
    Haptics.selectionAsync().catch(() => undefined);
  };

  const submit = () => {
    if (state.kind !== "open" || sending) return;
    const built = buildAnswer(spec, draft);
    if ("missing" in built) {
      setError(built.missing);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
      return;
    }
    setSending(true);
    setError(null);
    actions
      .answerQuestion(state.callId, built.answer)
      .then(() =>
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined),
      )
      .catch((reason: unknown) => {
        setError(messageOf(reason));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      })
      .finally(() => setSending(false));
  };

  const answered = state.kind === "answered" ? describeAnswer(spec, state.answer) : null;
  const borderColor = open && asks ? palette.accent : palette.borderDefault;

  return (
    <View
      accessibilityLabel={spec.title ?? (asks ? "Question" : undefined)}
      style={[styles.card, { backgroundColor: palette.surfaceElevated, borderColor }]}
    >
      {asks ? (
        <Text
          maxFontSizeMultiplier={maxFontScale.chrome}
          style={[text.caption2, { color: open ? palette.accentText : palette.textMuted }]}
        >
          {open ? "Question for you" : state.kind === "answered" ? "Answered" : "Question"}
        </Text>
      ) : null}
      {spec.title ? (
        <Text accessibilityRole="header" style={[text.headline, { color: palette.textStrong }]}>
          {spec.title}
        </Text>
      ) : null}
      {spec.blocks.map((block, index) => (
        <Block
          block={block}
          disabled={!open || sending}
          draft={draft}
          key={index}
          onChange={set}
          palette={palette}
        />
      ))}
      {answered && answered.length > 0 ? (
        <View style={[styles.answer, { backgroundColor: palette.successTint }]}>
          {answered.map((line) => (
            <Text key={line} style={[text.footnote, { color: palette.successText }]}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {asks && state.kind === "closed" ? (
        <Text style={[text.footnote, { color: palette.textMuted }]}>
          Not answered. Reply in the chat instead.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={[text.footnote, { color: palette.dangerText }]}>
          {error}
        </Text>
      ) : null}
      {open && asks ? (
        <Button busy={sending} label="Send answer" onPress={submit} variant="accent" />
      ) : null}
    </View>
  );
}

function Block({
  block,
  draft,
  disabled,
  onChange,
  palette,
}: {
  readonly block: UiNode;
  readonly draft: Draft;
  readonly disabled: boolean;
  readonly onChange: (id: string, value: string | readonly string[] | boolean) => void;
  readonly palette: Palette;
}) {
  switch (block.type) {
    case "text":
      return <Text style={[text.subheadline, { color: palette.text }]}>{block.text}</Text>;
    case "card":
      return (
        <View style={[styles.inner, { backgroundColor: palette.surface }]}>
          <Text style={[text.subheadline, styles.semibold, { color: palette.textStrong }]}>
            {block.title}
          </Text>
          {block.subtitle ? (
            <Text style={[text.footnote, { color: palette.textMuted }]}>{block.subtitle}</Text>
          ) : null}
          {block.children.map((child, index) => (
            <Block
              block={child}
              disabled={disabled}
              draft={draft}
              key={index}
              onChange={onChange}
              palette={palette}
            />
          ))}
        </View>
      );
    case "checklist":
      return (
        <View style={styles.stack}>
          {block.title ? (
            <Text style={[text.footnote, styles.semibold, { color: palette.textMuted }]}>
              {block.title}
            </Text>
          ) : null}
          {block.items.map((item, index) => (
            <View key={`${index}:${item.label}`} style={styles.checkRow}>
              <CheckGlyph palette={palette} status={item.status} />
              <View style={styles.flex}>
                <Text
                  style={[
                    text.subheadline,
                    {
                      color: item.status === "done" ? palette.textMuted : palette.text,
                      textDecorationLine: item.status === "done" ? "line-through" : "none",
                    },
                  ]}
                >
                  {item.label}
                </Text>
                {item.note ? (
                  <Text style={[text.footnote, { color: palette.textMuted }]}>{item.note}</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      );
    case "choice": {
      const value = draft[block.id];
      const picked = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      const known = new Set(block.options.map((option) => option.id));
      const other = picked.find((entry) => !known.has(entry)) ?? "";
      const toggle = (id: string) => {
        if (!block.multiple) return onChange(block.id, id);
        onChange(
          block.id,
          picked.includes(id) ? picked.filter((entry) => entry !== id) : [...picked, id],
        );
      };
      return (
        <View style={styles.stack}>
          <Text style={[text.subheadline, styles.semibold, { color: palette.textStrong }]}>
            {block.label}
          </Text>
          {block.options.map((option) => {
            const selected = picked.includes(option.id);
            return (
              <PressableScale
                accessibilityLabel={option.label}
                accessibilityRole={block.multiple ? "checkbox" : "radio"}
                accessibilityState={{ checked: selected, disabled }}
                {...(option.description ? { accessibilityHint: option.description } : {})}
                disabled={disabled}
                key={option.id}
                onPress={() => toggle(option.id)}
                pressedStyle={{ backgroundColor: palette.overlayActive }}
                style={[
                  styles.option,
                  {
                    backgroundColor: selected ? palette.accentTint : palette.surface,
                    borderColor: selected ? palette.accent : palette.borderDefault,
                    opacity: disabled && !selected ? 0.6 : 1,
                  },
                ]}
              >
                <Icon
                  color={selected ? palette.accentText : palette.textSoft}
                  name={
                    block.multiple
                      ? selected
                        ? "checkmark.square.fill"
                        : "square"
                      : selected
                        ? "largecircle.fill.circle"
                        : "circle"
                  }
                  size={18}
                />
                <View style={styles.flex}>
                  <Text style={[text.subheadline, { color: palette.text }]}>{option.label}</Text>
                  {option.description ? (
                    <Text style={[text.footnote, { color: palette.textMuted }]}>
                      {option.description}
                    </Text>
                  ) : null}
                </View>
              </PressableScale>
            );
          })}
          {block.allowOther ? (
            <TextInput
              accessibilityLabel={`${block.label}: other`}
              editable={!disabled}
              onChangeText={(next) => {
                const rest = picked.filter((entry) => known.has(entry));
                const value = next.trim() ? [...rest, next] : rest;
                onChange(block.id, block.multiple ? value : next.trim() ? next : (rest[0] ?? ""));
              }}
              placeholder="Other…"
              placeholderTextColor={palette.textSoft}
              style={[styles.input, inputColors(palette)]}
              value={other}
            />
          ) : null}
        </View>
      );
    }
    case "form":
      return (
        <View style={styles.stack}>
          {block.fields.map((entry) => {
            if (entry.kind === "toggle") {
              return (
                <View key={entry.id} style={styles.toggleRow}>
                  <Text style={[text.subheadline, styles.flex, { color: palette.text }]}>
                    {entry.label}
                  </Text>
                  <Switch
                    accessibilityLabel={entry.label}
                    disabled={disabled}
                    onValueChange={(next) => onChange(entry.id, next)}
                    value={draft[entry.id] === true}
                  />
                </View>
              );
            }
            if (entry.kind === "select") {
              const value = draft[entry.id];
              return (
                <View key={entry.id} style={styles.stack}>
                  <Text style={[text.footnote, { color: palette.textMuted }]}>
                    {entry.label}
                    {entry.required ? " (required)" : ""}
                  </Text>
                  <View style={styles.chips}>
                    {entry.options.map((option) => {
                      const selected = value === option.id;
                      return (
                        <PressableScale
                          accessibilityRole="radio"
                          accessibilityState={{ checked: selected, disabled }}
                          disabled={disabled}
                          key={option.id}
                          onPress={() => onChange(entry.id, option.id)}
                          style={[
                            styles.chip,
                            {
                              backgroundColor: selected ? palette.accentTint : palette.surface,
                              borderColor: selected ? palette.accent : palette.borderDefault,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              text.subheadline,
                              { color: selected ? palette.accentText : palette.text },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </PressableScale>
                      );
                    })}
                  </View>
                </View>
              );
            }
            const value = draft[entry.id];
            return (
              <View key={entry.id} style={styles.stack}>
                <Text style={[text.footnote, { color: palette.textMuted }]}>
                  {entry.label}
                  {entry.required ? " (required)" : ""}
                </Text>
                <TextInput
                  accessibilityLabel={entry.label}
                  editable={!disabled}
                  multiline={entry.multiline}
                  onChangeText={(next) => onChange(entry.id, next)}
                  placeholder={entry.placeholder}
                  placeholderTextColor={palette.textSoft}
                  style={[
                    styles.input,
                    entry.multiline ? styles.multiline : null,
                    inputColors(palette),
                  ]}
                  value={typeof value === "string" ? value : ""}
                />
              </View>
            );
          })}
        </View>
      );
    case "table":
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={[styles.table, { borderColor: palette.borderDefault }]}>
            {[block.columns, ...block.rows].map((row, rowIndex) => (
              <View
                key={rowIndex}
                style={[
                  styles.tableRow,
                  rowIndex === 0 ? { backgroundColor: palette.surface } : null,
                  { borderColor: palette.borderDefault },
                ]}
              >
                {row.map((cell, cellIndex) => (
                  <Text
                    key={cellIndex}
                    style={[
                      text.footnote,
                      styles.cell,
                      { color: rowIndex === 0 ? palette.textStrong : palette.text },
                      rowIndex === 0 ? styles.semibold : null,
                    ]}
                  >
                    {cell}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "progress":
      return (
        <View
          accessibilityLabel={block.label}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(block.value * 100) }}
          style={styles.stack}
        >
          <View style={styles.toggleRow}>
            <Text style={[text.footnote, styles.flex, { color: palette.text }]}>{block.label}</Text>
            <Text style={[text.footnote, { color: palette.textMuted }]}>
              {Math.round(block.value * 100)}%
            </Text>
          </View>
          <View style={[styles.track, { backgroundColor: palette.overlayActive }]}>
            <View
              style={[
                styles.fill,
                { backgroundColor: palette.accent, width: `${block.value * 100}%` },
              ]}
            />
          </View>
        </View>
      );
    case "callout": {
      const [fill, ink] =
        block.tone === "error"
          ? [palette.dangerTint, palette.dangerText]
          : block.tone === "warning"
            ? [palette.warningTint, palette.warningText]
            : block.tone === "success"
              ? [palette.successTint, palette.successText]
              : [palette.accentTint, palette.accentText];
      return (
        <View style={[styles.inner, { backgroundColor: fill }]}>
          <Text style={[text.subheadline, { color: ink }]}>{block.text}</Text>
        </View>
      );
    }
    case "code":
      return (
        <ScrollView horizontal style={[styles.code, { backgroundColor: palette.codeBlock }]}>
          <Text selectable style={[styles.mono, { color: palette.text }]}>
            {block.code}
          </Text>
        </ScrollView>
      );
    case "list":
      return (
        <View style={styles.stack}>
          {block.title ? (
            <Text style={[text.footnote, styles.semibold, { color: palette.textMuted }]}>
              {block.title}
            </Text>
          ) : null}
          {block.lines.map((line, index) => (
            <Text key={index} style={[text.footnote, { color: palette.text }]}>
              {line}
            </Text>
          ))}
        </View>
      );
  }
}

function CheckGlyph({
  status,
  palette,
}: {
  readonly status: ChecklistStatus;
  readonly palette: Palette;
}) {
  const label =
    status === "done"
      ? "Done"
      : status === "running"
        ? "In progress"
        : status === "failed"
          ? "Failed"
          : "Pending";
  return (
    <View accessible accessibilityLabel={label} style={styles.glyph}>
      {status === "running" ? (
        <Spinner color={palette.accentText} size={13} />
      ) : (
        <Icon
          color={
            status === "done"
              ? palette.successText
              : status === "failed"
                ? palette.dangerText
                : palette.textSoft
          }
          name={
            status === "done"
              ? "checkmark.circle.fill"
              : status === "failed"
                ? "xmark.circle.fill"
                : "circle"
          }
          size={16}
        />
      )}
    </View>
  );
}

function inputColors(palette: Palette) {
  return {
    backgroundColor: palette.background,
    borderColor: palette.borderDefault,
    color: palette.text,
  };
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.float,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  inner: { borderRadius: radius.md2, padding: spacing.md, gap: spacing.sm2 },
  stack: { gap: spacing.sm },
  flex: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: "600" },
  checkRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  glyph: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  option: {
    minHeight: hitSize.min,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    minHeight: hitSize.min,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    ...text.callout,
  },
  multiline: { minHeight: 96, paddingTop: spacing.md, textAlignVertical: "top" },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: hitSize.min,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    minHeight: hitSize.min,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, overflow: "hidden" },
  tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  cell: {
    minWidth: 96,
    maxWidth: 220,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm2,
  },
  track: { height: 6, borderRadius: radius.pill, overflow: "hidden" },
  fill: { height: 6, borderRadius: radius.pill },
  code: { borderRadius: radius.md2, padding: spacing.md },
  mono: { ...text.mono, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
  answer: { borderRadius: radius.md2, padding: spacing.md, gap: spacing.xs },
});
