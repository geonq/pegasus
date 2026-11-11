import { useColorScheme } from "react-native";

/**
 * Every color the app draws comes from these tokens. The palette is rito's (the owner's logos in
 * iCloud/rito): obsidian #09090B, white #FFFFFF and electric blue #0066FF. Obsidian leads; the light
 * scheme mirrors it. Change a value here and the whole app follows.
 */
export interface Palette {
  readonly background: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly line: string;
  readonly text: string;
  readonly textMuted: string;
  /** Fills: buttons, the send button, status. Text on it uses onAccent. */
  readonly accent: string;
  /** Accent as text (links, small controls), lighter on obsidian so it stays readable. */
  readonly accentText: string;
  readonly onAccent: string;
  readonly success: string;
  readonly danger: string;
  readonly warning: string;
  readonly userBubble: string;
}

const brand = { obsidian: "#09090b", white: "#ffffff", electricBlue: "#0066ff" } as const;

const light: Palette = {
  background: brand.white,
  surface: "#f6f6f8",
  surfaceRaised: "#ececf0",
  line: "#e2e2e7",
  text: brand.obsidian,
  textMuted: "#6c6c75",
  accent: brand.electricBlue,
  accentText: "#0057d9",
  onAccent: brand.white,
  success: "#1f8a55",
  danger: "#c8323f",
  warning: "#b36b00",
  userBubble: "#e6efff",
};

const dark: Palette = {
  background: brand.obsidian,
  surface: "#121216",
  surfaceRaised: "#1b1b21",
  line: "#25252c",
  text: brand.white,
  textMuted: "#8d8d97",
  accent: brand.electricBlue,
  accentText: "#3d8bff",
  onAccent: brand.white,
  success: "#34c77b",
  danger: "#ff5468",
  warning: "#f0a020",
  userBubble: "#0b2350",
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 18 } as const;
export const type = { caption: 12, body: 16, title: 17, large: 28 } as const;

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}
