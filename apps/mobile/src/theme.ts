import { useColorScheme } from "react-native";

/**
 * Every color the app draws comes from these tokens. They follow the desktop "Default" preset
 * (apps/desktop/contracts/theme.ts: neutral surfaces, the owner's blue accent #0253C4) until the
 * iOS palette arrives: replace the two objects below and the whole app follows.
 */
export interface Palette {
  readonly background: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly line: string;
  readonly text: string;
  readonly textMuted: string;
  readonly accent: string;
  readonly onAccent: string;
  readonly success: string;
  readonly danger: string;
  readonly warning: string;
  readonly userBubble: string;
}

const light: Palette = {
  background: "#fafafa",
  surface: "#ffffff",
  surfaceRaised: "#f0f0f0",
  line: "#e3e3e3",
  text: "#0a0a0a",
  textMuted: "#6b6b6b",
  accent: "#0253c4",
  onAccent: "#ffffff",
  success: "#2f825a",
  danger: "#b84e59",
  warning: "#ac711c",
  userBubble: "#eef3fb",
};

const dark: Palette = {
  background: "#161616",
  surface: "#1e1e1e",
  surfaceRaised: "#262626",
  line: "#2e2e2e",
  text: "#f5f5f5",
  textMuted: "#9a9a9a",
  accent: "#0253c4",
  onAccent: "#ffffff",
  success: "#40c977",
  danger: "#e05467",
  warning: "#d97706",
  userBubble: "#1d2a3d",
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 18 } as const;
export const type = { caption: 12, body: 16, title: 17, large: 28 } as const;

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}
