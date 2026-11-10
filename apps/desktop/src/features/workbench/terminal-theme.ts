import type { ITheme } from "@xterm/xterm";
import type { ActiveTheme } from "../../ui/active-theme";

/**
 * Windows Terminal's stock schemes: "Campbell" for dark UIs and "One Half Light"
 * for light ones. CLIs hard-code assumptions about these vivid 16 colours (Claude
 * Code's orange, git's red/green); deriving them from the app preset washed them
 * out to near-monochrome.
 */
const CAMPBELL = {
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
} as const;

const ONE_HALF_LIGHT = {
  black: "#383a42",
  red: "#e45649",
  green: "#50a14f",
  yellow: "#c18401",
  blue: "#0184bc",
  magenta: "#a626a4",
  cyan: "#0997b3",
  white: "#fafafa",
  brightBlack: "#4f525d",
  brightRed: "#df6c75",
  brightGreen: "#98c379",
  brightYellow: "#e4c07a",
  brightBlue: "#61afef",
  brightMagenta: "#c577dd",
  brightCyan: "#56b5c1",
  brightWhite: "#ffffff",
} as const;

/** The terminal sits on the app's main surface; only the 16 ANSI colours are fixed. */
export function terminalThemeFor(theme: ActiveTheme): ITheme {
  const { tokens } = theme;
  const token = (name: `--${string}`): string => tokens[name] ?? "";
  return {
    ...(theme.variant === "light" ? ONE_HALF_LIGHT : CAMPBELL),
    // Opaque: xterm's DOM renderer paints its viewport #000 when the background is transparent.
    background: token("--main"),
    foreground: token("--text"),
    cursor: token("--text-strong"),
    cursorAccent: token("--main"),
    selectionBackground: token("--terminal-selection"),
  };
}
