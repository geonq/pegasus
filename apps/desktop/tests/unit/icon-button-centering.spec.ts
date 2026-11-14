import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Owner rule: icons sit dead centre in their buttons. The browser's default button padding
// (1px 6px) squeezed a 12px cross inside a 20px circle and pushed it off-centre.
test("buttons start with no browser padding, so small icon buttons centre their icon", () => {
  const css = readFileSync(path.join(__dirname, "../../src/styles/base.css"), "utf8");
  const rule = css.match(/(?:^|\n)button\s*\{([^}]*)\}/);
  expect(rule?.[1]).toMatch(/padding:\s*0\s*;/);
});

test("the photo remove button sits inside the photo corner and centres its cross", () => {
  const css = readFileSync(path.join(__dirname, "../../src/styles/main.css"), "utf8");
  const base = css.match(/\.composer-attachment__remove\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(base).toMatch(/padding:\s*0/);
  expect(base).toMatch(/place-items:\s*center/);
  const image = css.match(/\.composer-attachment--image \.composer-attachment__remove\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(image).not.toMatch(/top:\s*-/);
  expect(image).not.toMatch(/right:\s*-/);
});
