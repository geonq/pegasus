import { LRUCache } from "lru-cache";
import bash from "@shikijs/langs/bash";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import python from "@shikijs/langs/python";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";
import darkPlus from "@shikijs/themes/dark-plus";
import dracula from "@shikijs/themes/dracula";
import githubDarkDefault from "@shikijs/themes/github-dark-default";
import githubLightDefault from "@shikijs/themes/github-light-default";
import gruvboxDarkMedium from "@shikijs/themes/gruvbox-dark-medium";
import gruvboxLightMedium from "@shikijs/themes/gruvbox-light-medium";
import lightPlus from "@shikijs/themes/light-plus";
import nord from "@shikijs/themes/nord";
import tokyoNight from "@shikijs/themes/tokyo-night";
import { useSyncExternalStore } from "react";
import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import type { SyntaxThemeId } from "../../contracts/theme";
import draculaLight from "./syntax-themes/dracula-light.json";
import nordLight from "./syntax-themes/nord-light.json";
import tokyoNightLight from "./syntax-themes/tokyo-night-light.json";

/*
 * Code colours come from the active preset's VS Code theme file, the same file
 * its seed was taken from. Themes without a shiki bundle (Tokyo Night light,
 * Nord light, Dracula's Alucard) are shipped in ./syntax-themes.
 */

export const syntaxThemes: Readonly<Record<SyntaxThemeId, ThemeRegistration>> = {
  "github-light-default": githubLightDefault,
  "github-dark-default": githubDarkDefault,
  "catppuccin-latte": catppuccinLatte,
  "catppuccin-mocha": catppuccinMocha,
  "tokyo-night-light": tokyoNightLight as ThemeRegistration,
  "tokyo-night": tokyoNight,
  "nord-light": nordLight as ThemeRegistration,
  nord,
  "dracula-light": draculaLight as ThemeRegistration,
  dracula,
  "gruvbox-light-medium": gruvboxLightMedium,
  "gruvbox-dark-medium": gruvboxDarkMedium,
  "light-plus": lightPlus,
  "dark-plus": darkPlus,
};

const languages = [typescript, tsx, javascript, json, python, bash];

// Additional grammars are split into demand-loaded chunks. Keeping only the
// common six in the initial core preserves the fast renderer startup.
const lazyGrammars: Readonly<Record<string, () => Promise<unknown>>> = {
  css: () => import("@shikijs/langs/css"), scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"), markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"), toml: () => import("@shikijs/langs/toml"),
  rust: () => import("@shikijs/langs/rust"), swift: () => import("@shikijs/langs/swift"),
  go: () => import("@shikijs/langs/go"), sql: () => import("@shikijs/langs/sql"),
  powershell: () => import("@shikijs/langs/powershell"), xml: () => import("@shikijs/langs/xml"),
  dockerfile: () => import("@shikijs/langs/dockerfile"), ini: () => import("@shikijs/langs/ini"),
  diff: () => import("@shikijs/langs/diff"), c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"), java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"), ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"), vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
};

// Oniguruma (VS Code's regex engine, as wasm) tokenises several times faster
// than shiki's JavaScript engine. It loads asynchronously at startup; code
// renders plain until it is ready, then each grammar is compiled while idle so
// the first diff does not pay for it.
let highlighter: HighlighterCore | null = null;
const readyListeners = new Set<() => void>();

export const highlighterReady: Promise<void> = createHighlighterCore({
  themes: Object.values(syntaxThemes),
  langs: languages,
  engine: createOnigurumaEngine(import("shiki/wasm")),
}).then(
  (created) => {
    highlighter = created;
    for (const listener of readyListeners) listener();
    warmGrammars(created);
  },
  (error: unknown) => {
    console.error("[renderer] syntax highlighter failed to load", error);
  },
);

/** Re-renders the caller once the highlighter has loaded. */
export function useHighlighterReady(): boolean {
  return useSyncExternalStore(
    (listener) => {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    () => highlighter !== null,
  );
}

function warmGrammars(created: HighlighterCore): void {
  const idle =
    typeof requestIdleCallback === "function"
      ? requestIdleCallback
      : (callback: () => void) => setTimeout(callback, 0);
  const pending = Object.values(EXTENSION_TO_LANGUAGE).filter(
    (language, index, all) => all.indexOf(language) === index,
  );
  const warmNext = (): void => {
    const language = pending.shift();
    if (!language) return;
    created.codeToTokensBase("const x = 1", { lang: language, theme: "github-light-default" });
    idle(warmNext);
  };
  idle(warmNext);
}

export const MAX_HIGHLIGHTED_LINES = 5000;

// TextMate FontStyle.Italic (the enum is not re-exported by shiki).
const ITALIC = 1;

export interface HighlightToken {
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: "italic";
}

export type HighlightLine = readonly HighlightToken[];

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "tsx",
  json: "json",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css", scss: "scss", html: "html", htm: "html", md: "markdown", markdown: "markdown",
  yml: "yaml", yaml: "yaml", toml: "toml", rs: "rust", swift: "swift", go: "go", sql: "sql",
  ps1: "powershell", psm1: "powershell", xml: "xml", svg: "xml", dockerfile: "dockerfile",
  ini: "ini", cfg: "ini", diff: "diff", patch: "diff", c: "c", h: "c", cc: "cpp", cpp: "cpp",
  cxx: "cpp", java: "java", kt: "kotlin", kts: "kotlin", rb: "ruby", php: "php", vue: "vue", svelte: "svelte",
};

export function extensionToLanguage(filePath: string): string | undefined {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex < 0) return undefined;
  const ext = filePath.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext];
}

const FENCE_ALIASES: Readonly<Record<string, string>> = {
  ...EXTENSION_TO_LANGUAGE,
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
  shell: "bash",
  console: "bash",
  jsonc: "json",
};

/** The loaded grammar for a markdown fence's info string (```ts, ```python …), if any. */
export function fenceToLanguage(info: string): string | undefined {
  return FENCE_ALIASES[info.trim().toLowerCase()];
}

const lineCache = new LRUCache<string, HighlightLine>({ max: 5000 });
const blockCache = new LRUCache<string, readonly HighlightLine[]>({ max: 100 });
const loadingGrammars = new Set<string>();

function ensureGrammar(language: string): void {
  if (!highlighter || !lazyGrammars[language] || highlighter.getLoadedLanguages().includes(language)) return;
  if (loadingGrammars.has(language)) return;
  loadingGrammars.add(language);
  void lazyGrammars[language]().then((module) => {
    const grammar = (module as { default?: unknown }).default ?? module;
    return highlighter?.loadLanguage(grammar as never);
  }).then(() => {
    loadingGrammars.delete(language);
    for (const listener of readyListeners) listener();
  }, (error: unknown) => {
    loadingGrammars.delete(language);
    console.error(`[renderer] failed to load ${language} grammar`, error);
  });
}

function toHighlightLines(code: string, language: string, theme: SyntaxThemeId): readonly HighlightLine[] | null {
  if (!highlighter) return null;
  ensureGrammar(language);
  if (!highlighter.getLoadedLanguages().includes(language)) return null;
  const themeName = syntaxThemes[theme].name ?? theme;
  const foreground = highlighter.getTheme(themeName).fg.toLowerCase();
  return highlighter.codeToTokensBase(code, { lang: language, theme: themeName }).map((line) => line.map((token) => {
    const color = token.color?.toLowerCase();
    return { content: token.content, ...(color && color !== foreground ? { color } : {}), ...(token.fontStyle !== undefined && token.fontStyle & ITALIC ? { fontStyle: "italic" as const } : {}) };
  }));
}

export function highlightLines(code: string, language: string, theme: SyntaxThemeId): readonly HighlightLine[] | null {
  const key = `${theme}\0${language}\0${code}`;
  const cached = blockCache.get(key);
  if (cached) return cached;
  const lines = toHighlightLines(code, language, theme);
  if (lines) blockCache.set(key, lines);
  return lines;
}

/** Coloured tokens for one line, or null until the highlighter has loaded. */
export function highlightLine(
  line: string,
  language: string,
  theme: SyntaxThemeId,
): HighlightLine | null {
  if (!highlighter) return null;
  ensureGrammar(language);
  const cacheKey = `${theme}\0${language}\0${line}`;
  const cached = lineCache.get(cacheKey);
  if (cached) return cached;
  const themeName = syntaxThemes[theme].name ?? theme;
  // The editor foreground is inherited from the surrounding text, so plain
  // tokens carry no colour and follow the app's --code-ink.
  const foreground = highlighter.getTheme(themeName).fg.toLowerCase();
  const tokens = (highlighter.codeToTokensBase(line, { lang: language, theme: themeName })[0] ?? []).map((token): HighlightToken => {
    const color = token.color?.toLowerCase();
    return {
      content: token.content,
      ...(color && color !== foreground ? { color } : {}),
      ...(token.fontStyle !== undefined && token.fontStyle & ITALIC
        ? { fontStyle: "italic" as const }
        : {}),
    };
  });
  lineCache.set(cacheKey, tokens);
  return tokens;
}
