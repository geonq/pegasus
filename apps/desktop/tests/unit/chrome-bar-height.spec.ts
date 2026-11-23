import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const styles = path.join(__dirname, "../../src/styles");
const rule = (file: string, selector: string) =>
  readFileSync(path.join(styles, file), "utf8").match(
    new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`),
  )?.[1] ?? "";

// Opening the side panel moved its toggle up: the panel's tab bar was 40px while the top bar
// was 48px. Both bars must share one height. The Windows caption buttons are drawn by the app
// since 50c50b6a (no titleBarOverlay); their alignment is covered by window-controls-align.spec.ts.
test("the top bar and the side panel tab bar share the window-chrome height", () => {
  expect(rule("topbar.css", ".topbar")).toMatch(/height:\s*var\(--chrome-bar-height\)/);
  expect(rule("workbench.css", ".workbench__tabbar")).toMatch(
    /height:\s*var\(--chrome-bar-height\)/,
  );
  const tokens = readFileSync(path.join(styles, "tokens.css"), "utf8");
  expect(tokens).toMatch(/--chrome-bar-height:\s*48px/);
});
