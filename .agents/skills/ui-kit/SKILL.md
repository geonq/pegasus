---
name: ui-kit
description: Builds and reviews Pegasus renderer widgets (menus, tabs, dialogs, listboxes, selects, switches, radio groups) on the vendored ui-kit in apps/desktop/src/ui-kit. Use for any change that adds or edits an interactive control, a role= attribute, a popup or a keyboard path in apps/desktop/src, and as the last pass over every renderer diff.
---

# Pegasus ui-kit

`apps/desktop/src/ui-kit` is our own copy of the ui-sdk behaviors and React parts
(vercel-labs/ui, commit c53df2f, Apache-2.0; see `ui-kit/NOTICE.md`). It gives
keyboard navigation, focus, dismissal, popups and ARIA, and renders no styles.
Pegasus keeps its own tokens, glass and type. There is no npm dependency on
`@ui-sdk/*`; nothing is fetched at build or run time. The agent/WebMCP layer was
left out on purpose: never add it back, never write `data-agent-*`.

## Rules for every widget

- **Use the kit, don't hand-roll.** Before writing `role="listbox"`, `"menu"`,
  `"dialog"`, `"tablist"`, `"separator"`, `"switch"`, `"slider"`,
  `"radiogroup"`, `"toolbar"` or `"tree"`, import the part from
  `src/ui-kit/react/<name>`. A hand-rolled one is a bug unless the commit says
  why the kit can't do it.
- **One shape.** A root and its parts, nested as the component's source shows.
  Change a part's element with `render`, never an `as` prop.
- **Default or controlled.** `defaultValue` to start, or `value` with
  `onValueChange(value, details)`. `details` has `reason`, `source` and `cancel()`.
- **Name every control.** A visible label part (`DialogTitle`, a field label) or
  `aria-label` when there is no visible text.
- **Style from state.** Target `data-slot` and state attributes (`data-open`,
  `data-selected`, `data-highlighted`, `aria-checked`, …). Never inline styles
  for state, never generated ids in selectors. Custom properties for data, like
  a provider colour, are fine.
- **Contrast.** Text 4.5:1 against what is painted behind it; control edges,
  focus rings and state fills 3:1. Check every reachable state in both themes.
- **Key lists by id**, never by index.
- Right to left needs no provider; the kit reads the page direction.

## Pegasus owner rules

- Sentence case only. No all caps, no `text-transform: uppercase`.
- Provider colours come from `features/usage/brand-color.ts`
  (`providerColor`), passed as `--brand`, the way Usage does it.
- Hovers are subtle: `var(--overlay-hover)`, no jumps, no bold shifts.
- Keep our glass, tokens and type; never import ui-sdk's `web.css` look.

## Unslop every diff

Behavior never changes during cleanup. Remove:

- comments that say what the next line does, banner comments, task or history
  narration ("now we", "fixed the bug where"), comments longer than three lines;
- JSDoc on app code that repeats the name; hedge or sales words (robust,
  seamless, simply, just, ensure, leverage, note that);
- defensive checks the types rule out, casts or `!` without a reason;
- one-caller helpers and rename-only wrappers, options nobody passes;
- vague names (`data`, `result`, `temp`, `handleClick2`); logs, probes,
  commented-out code.

Keep a comment only for a browser quirk, an APG rule or a trade-off, in at most
three lines. Read the diff once more and revert changes that don't read better.

## Test

Tests run in the Playwright lane against the real Electron renderer, never in
the foreground:

```powershell
Remove-Item Env:PI_REMOTE_DESKTOP_HOST_CONFIG -ErrorAction SilentlyContinue
$env:PI_APP_TEST_NO_SANDBOX='1'; $env:PI_APP_TEST_LANE='core'; $env:PI_APP_REAL_AUTH='0'; $env:PI_APP_TEST_MODE='background'
corepack pnpm --dir ../.. exec playwright test -c apps/desktop/playwright.config.ts <spec> --reporter=line
```

- Prove keyboard and ARIA with real key presses (`window.keyboard.press`):
  arrows, Home/End, typeahead, Escape returns focus to the trigger, Enter and
  Space activate. Assert names with `getByRole(role, { name })`.
- `checkPattern(root, pattern)` from `apps/desktop/tests/ui-kit-testing`
  checks roles, names, references and the APG keys. It dispatches DOM events,
  so it runs inside the renderer: bundle it for the page or use it in unit
  specs on a DOM. A menu check activates an item; open a safe menu first.
- Every press of every button in a dialog, Cancel too. Assert where focus lands.
- Before and after screenshots for any look change; same look is the default.
- Then `corepack pnpm exec tsc --noEmit -p tsconfig.json` and
  `corepack pnpm exec electron-vite build` in `apps/desktop`, exit 0.

Adapted from the ui-sdk and ui-sdk-unslop skills of vercel-labs/ui (commit
c53df2f), Apache License 2.0.
