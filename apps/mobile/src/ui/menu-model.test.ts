// node --test --experimental-strip-types src/ui/menu-model.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { menuEntries, menuItemById, placePopover, type MenuSection } from "./menu-model.ts";

test("menus: sections become rows with dividers and titles; disabled items do not fire", () => {
  let fired = "";
  const sections: MenuSection[] = [
    {
      items: [
        { id: "pin", label: "Pin", icon: "pin", onPress: () => (fired = "pin") },
        { id: "off", label: "Off", disabled: true, onPress: () => (fired = "off") },
      ],
    },
    { items: [] },
    {
      title: "Danger",
      items: [{ id: "archive", label: "Archive", destructive: true, onPress: () => undefined }],
    },
  ];
  assert.deepEqual(
    menuEntries(sections).map((entry) => `${entry.kind}:${entry.key}`),
    ["item:pin", "item:off", "divider:divider-1", "title:title-1", "item:archive"],
  );
  assert.deepEqual(
    menuEntries([sections[0] as MenuSection]).map((entry) => entry.kind),
    ["item", "item"],
  );
  menuItemById(sections, "pin")?.onPress();
  assert.equal(fired, "pin");
  assert.equal(menuItemById(sections, "off"), undefined);
  assert.equal(menuItemById(sections, "missing"), undefined);
});

test("a popover opens below its trigger when it fits, above when not, and stays on screen", () => {
  const screen = { width: 390, height: 844 };
  const insets = { top: 47, bottom: 34 };
  const size = { width: 240, height: 200 };
  const low = placePopover({ x: 330, y: 60, width: 44, height: 44 }, size, screen, insets);
  assert.equal(low.y, 110);
  assert.equal(low.x, 374 - 240); // right-aligned to the trigger
  assert.equal(low.origin, "top right");
  const high = placePopover({ x: 10, y: 740, width: 120, height: 32 }, size, screen, insets);
  assert.equal(high.y, 740 - 6 - 200);
  assert.equal(high.x, 10);
  assert.equal(high.origin, "bottom left");
  const wide = placePopover(
    { x: 0, y: 60, width: 20, height: 20 },
    { width: 400, height: 100 },
    screen,
    insets,
  );
  assert.equal(wide.x, 8);
  assert.equal(wide.width, 374);
});
