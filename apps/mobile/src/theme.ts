import { Easing } from "react-native-reanimated";
import { useColorScheme, type TextStyle, type ViewStyle } from "react-native";

/**
 * Every color the app draws comes from these tokens. They are the Pegasus desktop app's "default"
 * theme (black and white with the owner's blue #0253C4), computed by the desktop's own
 * `deriveThemeTokens` (apps/desktop/contracts/theme.ts) from the seeds at its lines 67 and 71, so
 * phone and desktop share one look. The desktop CSS variable each key mirrors is in its comment.
 * Change a value here and the whole app follows.
 */
export interface Palette {
  /** --main: the chat column and every screen's background. */
  readonly background: string;
  /** --surface-muted: cards, grouped lists, inputs, the desktop's user bubble fill. */
  readonly surface: string;
  /** A step above `surface`: pressed rows, banners, the selected segment. */
  readonly surfaceRaised: string;
  /** --line */
  readonly line: string;
  /** --text: body text. Titles may use `textStrong`. */
  readonly text: string;
  /** --muted: secondary text, 4.5:1 on every surface here. */
  readonly textMuted: string;
  /** Fills: buttons, the send button, status. Text on it uses onAccent. */
  readonly accent: string;
  /** --link: accent as text (links, small controls), 4.5:1 on the background. */
  readonly accentText: string;
  readonly onAccent: string;
  /** --success */
  readonly success: string;
  /** --error */
  readonly danger: string;
  /** --warning */
  readonly warning: string;
  /** --surface-muted, like the desktop's .timeline-item__bubble. */
  readonly userBubble: string;

  // Added with the desktop port. Prefer these in new code.
  /** --window: behind everything, the darkest neutral. */
  readonly window: string;
  /** --sidebar: the desktop's floating card fill (--float-fill). */
  readonly sidebar: string;
  /** --surface: elevated cards, sheets and menus when opaque. */
  readonly surfaceElevated: string;
  /** --surface-float: menus, toasts, dialogs. Translucent; see `material`. */
  readonly surfaceFloat: string;
  /** --line-strong */
  readonly lineStrong: string;
  /** --text-strong: titles and active labels. */
  readonly textStrong: string;
  /** --muted-soft: hints and disabled text. */
  readonly textSoft: string;
  /** --button-primary-bg / -ink: the desktop's primary button is ink on paper, not blue. */
  readonly primaryFill: string;
  readonly onPrimary: string;
  readonly primaryDisabledFill: string;
  readonly onPrimaryDisabled: string;
  /** --error-ink, --success-ink, --warning-ink: status hues as readable text. */
  readonly dangerText: string;
  readonly successText: string;
  readonly warningText: string;
  /** --accent-tint-bg, --success-tint-bg, --danger-tint-bg, --danger-tint-border */
  readonly accentTint: string;
  readonly successTint: string;
  readonly dangerTint: string;
  readonly dangerTintBorder: string;
  /** The desktop has no warning tint; this is --warning at --success-tint-bg's 14 %. */
  readonly warningTint: string;
  /** --overlay-subtle / -hover / -active: pressed and selected washes over any surface. */
  readonly overlaySubtle: string;
  readonly overlayHover: string;
  readonly overlayActive: string;
  /** --border-light / -default / -heavy: alpha hairlines that work on any surface. */
  readonly borderLight: string;
  readonly borderDefault: string;
  readonly borderHeavy: string;
  /** --status-neutral: idle dots. */
  readonly statusNeutral: string;
  /** --scrim: behind sheets and dialogs. */
  readonly scrim: string;
  /** --code-inline-bg, --code-block-bg */
  readonly codeInline: string;
  readonly codeBlock: string;
  /** The color shadows are cast in (--shadow-* use ink in light, black in dark). */
  readonly shadow: string;
}

export type Scheme = "light" | "dark";

const light: Palette = {
  background: "#fafafa",
  surface: "#f0f0f0",
  surfaceRaised: "#e9e9e9",
  line: "#dddddd",
  text: "#222222",
  textMuted: "#5e5e5e",
  accent: "#0253c4",
  accentText: "#0253c4",
  onAccent: "#ffffff",
  success: "#2f825a",
  danger: "#b84e59",
  warning: "#ac711c",
  userBubble: "#f0f0f0",

  window: "#e9e9e9",
  sidebar: "#f0f0f0",
  surfaceElevated: "#fcfcfc",
  surfaceFloat: "rgba(252, 252, 252, 0.78)",
  lineStrong: "#cccccc",
  textStrong: "#0a0a0a",
  textSoft: "#6c6c6c",
  primaryFill: "#0a0a0a",
  onPrimary: "#fafafa",
  primaryDisabledFill: "#cccccc",
  onPrimaryDisabled: "#6c6c6c",
  dangerText: "#7b363d",
  successText: "#20523a",
  warningText: "#7b5217",
  accentTint: "rgba(2, 83, 196, 0.12)",
  successTint: "rgba(47, 130, 90, 0.14)",
  dangerTint: "rgba(184, 78, 89, 0.10)",
  dangerTintBorder: "rgba(184, 78, 89, 0.18)",
  warningTint: "rgba(172, 113, 28, 0.14)",
  overlaySubtle: "rgba(10, 10, 10, 0.04)",
  overlayHover: "rgba(10, 10, 10, 0.06)",
  overlayActive: "rgba(10, 10, 10, 0.09)",
  borderLight: "rgba(10, 10, 10, 0.05)",
  borderDefault: "rgba(10, 10, 10, 0.08)",
  borderHeavy: "rgba(10, 10, 10, 0.13)",
  statusNeutral: "rgba(10, 10, 10, 0.34)",
  scrim: "rgba(10, 10, 10, 0.22)",
  codeInline: "#eeeeee",
  codeBlock: "#f2f2f2",
  shadow: "#0a0a0a",
};

const dark: Palette = {
  background: "#161616",
  surface: "#222222",
  // Desktop tint step: mix(--main, --text-strong, 0.09); the desktop has no named token for it.
  surfaceRaised: "#2a2a2a",
  line: "#2f2f2f",
  text: "#d8d8d8",
  textMuted: "#a2a2a2",
  accent: "#1560c8",
  accentText: "#4f87d4",
  onAccent: "#ffffff",
  success: "#40c977",
  danger: "#e05467",
  warning: "#d97706",
  userBubble: "#222222",

  window: "#101010",
  sidebar: "#121212",
  surfaceElevated: "#1c1c1c",
  surfaceFloat: "rgba(28, 28, 28, 0.78)",
  lineStrong: "#454545",
  textStrong: "#f5f5f5",
  textSoft: "#979797",
  primaryFill: "#f5f5f5",
  onPrimary: "#161616",
  primaryDisabledFill: "#454545",
  onPrimaryDisabled: "#979797",
  dangerText: "#e68492",
  successText: "#7fd8a3",
  warningText: "#e3a35a",
  accentTint: "rgba(21, 96, 200, 0.12)",
  successTint: "rgba(64, 201, 119, 0.14)",
  dangerTint: "rgba(224, 84, 103, 0.10)",
  dangerTintBorder: "rgba(224, 84, 103, 0.18)",
  warningTint: "rgba(217, 119, 6, 0.14)",
  overlaySubtle: "rgba(245, 245, 245, 0.04)",
  overlayHover: "rgba(245, 245, 245, 0.06)",
  overlayActive: "rgba(245, 245, 245, 0.09)",
  borderLight: "rgba(245, 245, 245, 0.05)",
  borderDefault: "rgba(245, 245, 245, 0.08)",
  borderHeavy: "rgba(245, 245, 245, 0.13)",
  statusNeutral: "rgba(245, 245, 245, 0.34)",
  scrim: "rgba(0, 0, 0, 0.5)",
  codeInline: "rgba(245, 245, 245, 0.08)",
  codeBlock: "rgba(0, 0, 0, 0.25)",
  shadow: "#000000",
};

export const palettes: Readonly<Record<Scheme, Palette>> = { light, dark };

/** The desktop's 4 px ramp (tokens.css --space-*). The first five keys predate the port. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxs: 2,
  /** --space-1-5 */
  sm2: 6,
  /** --space-2-5 */
  md2: 10,
  /** --space-5 */
  lg2: 20,
  /** --space-7 */
  xl2: 28,
  xxl: 32,
  /** The desktop's --float-gap: between cards and from screen edges. */
  gutter: 8,
} as const;

/**
 * The desktop's radius ramp (tokens.css --radius-*). sm, md and lg already matched it (8, 12, 18).
 * A nested shape's radius is its container's minus the inset between them (concentric corners).
 */
export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  /** --radius-xs */
  xs: 4,
  /** --radius-sm: chips, small controls. */
  sm2: 6,
  /** --radius-lg */
  md2: 10,
  /** --radius-2xl: the floating cards (--float-radius). */
  float: 14,
  /** --radius-3xl */
  lg2: 16,
  /** --radius-composer */
  composer: 18,
  pill: 999,
} as const;

/**
 * Font sizes. The desktop ramp is compact (11-28 px, tokens.css --text-*); on a phone held at arm's
 * length each role takes the matching iOS Dynamic Type default instead, and React Native scales
 * them with the person's text size (allowFontScaling is on by default). Existing keys keep values.
 */
export const type = {
  caption: 12,
  body: 16,
  title: 17,
  large: 28,
  /** iOS caption 2, desktop --text-xs */
  caption2: 11,
  /** iOS footnote, desktop --text-body */
  footnote: 13,
  /** iOS subheadline, desktop --text-md */
  subheadline: 15,
  /** iOS body */
  bodyLarge: 17,
  /** iOS title 3, desktop --text-xl */
  title3: 20,
  /** iOS title 2 */
  title2: 22,
} as const;

/** The desktop's weights (tokens.css --font-*), as React Native wants them. */
export const weight = {
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
} as const satisfies Record<string, TextStyle["fontWeight"]>;

/**
 * Text roles: one style per job, with the desktop's weights and the iOS Dynamic Type sizes and
 * leading. SF Pro is the system font on iOS, as on the desktop (base.css --font-ui), so no family.
 * Titles of 20 and up tighten slightly, like SF Pro Display.
 */
export const text = {
  largeTitle: { fontSize: type.large, lineHeight: 34, fontWeight: weight.bold, letterSpacing: 0.2 },
  title: { fontSize: type.title2, lineHeight: 28, fontWeight: weight.semibold, letterSpacing: -0.2 },
  title3: { fontSize: type.title3, lineHeight: 25, fontWeight: weight.semibold, letterSpacing: -0.2 },
  headline: { fontSize: type.title, lineHeight: 22, fontWeight: weight.semibold },
  body: { fontSize: type.bodyLarge, lineHeight: 22, fontWeight: weight.normal },
  callout: { fontSize: type.body, lineHeight: 21, fontWeight: weight.normal },
  subheadline: { fontSize: type.subheadline, lineHeight: 20, fontWeight: weight.normal },
  footnote: { fontSize: type.footnote, lineHeight: 18, fontWeight: weight.normal },
  caption: { fontSize: type.caption, lineHeight: 16, fontWeight: weight.normal },
  caption2: { fontSize: type.caption2, lineHeight: 13, fontWeight: weight.medium },
  mono: { fontSize: type.footnote, lineHeight: 18, fontFamily: "Menlo" },
} as const satisfies Record<string, TextStyle>;

/** Largest Dynamic Type growth for dense chrome (chips, badges); body text stays unbounded. */
export const maxFontScale = { chrome: 1.6 } as const;

/** Touch targets: Apple's 44 pt minimum, and the desktop's 32 px first-control height for chips. */
export const hitSize = { min: 44, compact: 32 } as const;

/** The desktop's motion (tokens.css --motion-*, --ease-out), for Reanimated. */
export const motion = {
  fast: 120,
  base: 150,
  slow: 240,
  easeOut: Easing.bezier(0.23, 1, 0.32, 1),
  easeInOut: Easing.bezier(0.4, 0, 0.2, 1),
  /** Pressables shrink to this, like the desktop's :active. */
  pressScale: 0.97,
} as const;

/**
 * Shadows, from the desktop's --shadow-sm/md/lg (light/dark opacities from contracts/theme.ts) and
 * the floating cards' --float-shadow. React Native draws one shadow per view, so the desktop's
 * hairline ring is a border on the view instead (--elevation-hairline = 0.5 px --border-heavy).
 */
export function elevation(scheme: Scheme, level: "card" | "float" | "menu" | "modal"): ViewStyle {
  const dim = scheme === "dark";
  const color = palettes[scheme].shadow;
  switch (level) {
    case "card":
      return { shadowColor: color, shadowOpacity: dim ? 0.2 : 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } };
    case "float":
      return { shadowColor: "#000000", shadowOpacity: dim ? 0.28 : 0.1, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } };
    case "menu":
      return { shadowColor: color, shadowOpacity: dim ? 0.3 : 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 8 } };
    case "modal":
      return { shadowColor: color, shadowOpacity: dim ? 0.4 : 0.12, shadowRadius: 24, shadowOffset: { width: 0, height: 16 } };
  }
}

/**
 * The desktop's one glass (polish.css: --surface-float over blur(12px) saturate(180%)). The phone
 * has no blur module (expo-blur is not a dependency), and translucency without blur leaves text
 * behind readable through the card, so floating surfaces draw this nearly opaque fill instead.
 * shortcut: no real blur; add expo-blur and use BlurView in ui/Surface when a native rebuild is fine.
 */
export const material = {
  light: { fill: "rgba(252, 252, 252, 0.94)", border: "rgba(10, 10, 10, 0.13)" },
  dark: { fill: "rgba(28, 28, 28, 0.94)", border: "rgba(245, 245, 245, 0.13)" },
} as const satisfies Record<Scheme, { fill: string; border: string }>;

export function useScheme(): Scheme {
  return useColorScheme() === "dark" ? "dark" : "light";
}

export function usePalette(): Palette {
  return palettes[useScheme()];
}
