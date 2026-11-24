// node --test --experimental-strip-types src/features/home/home-text.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPreview, cleanTitle, homeSummary, shortAddress } from "./home-text.ts";

test("titles lose markdown and line breaks", () => {
  assert.equal(cleanTitle("## Fix `the` **build**\nplease"), "Fix the build please");
  assert.equal(cleanTitle("See [docs](http://x.y) now"), "See docs now");
  assert.equal(cleanTitle("  `` "), "Untitled chat");
});

test("an empty preview stays empty", () => {
  assert.equal(cleanPreview("  \n "), "");
  assert.equal(cleanPreview("Done.\n\nPushed `main`"), "Done. Pushed main");
});

test("the summary names only what is non-zero", () => {
  assert.equal(homeSummary(0, 0), null);
  assert.equal(homeSummary(1, 0), "1 needs you");
  assert.equal(homeSummary(2, 1), "2 need you · 1 working");
});

test("the address drops its scheme", () => {
  assert.equal(shortAddress("http://100.1.2.3:47219/"), "100.1.2.3:47219");
});
