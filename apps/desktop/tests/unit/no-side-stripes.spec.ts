import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Owner rule: cards, callouts and notices never get a coloured bar down one side.
// Quotes are tinted boxes like the cards; only diff gutters and selection markers keep a side mark.
const allowed = [
  ".diff-line--added",
  ".file-editor__line--marked",
  ".tree-row--selected",
];

test("no card, callout or notice draws a coloured side stripe", () => {
  const dir = path.join(__dirname, "../../src/styles");
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".css"))) {
    const css = readFileSync(path.join(dir, file), "utf8");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1]!.trim();
      const body = rule[2]!;
      const stripe =
        /border-left:\s*[2-9]px/.test(body) ||
        /border-inline-start:\s*[2-9]px/.test(body) ||
        /border-left-color:/.test(body) ||
        /inset\s+[2-9]px\s+0\s+0/.test(body);
      if (stripe && !allowed.some((ok) => selector.includes(ok))) offenders.push(`${file}: ${selector}`);
    }
  }
  expect(offenders).toEqual([]);
});
