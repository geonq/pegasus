# ui-kit

Owned, internal copy of ui-sdk (https://github.com/vercel-labs/ui), commit
c53df2f ("fix(core): read the same cookie in the preferences script as on the
server (#453)"). Copyright Vercel, Inc. and contributors, Apache License 2.0
(see `LICENSE`). Pegasus changed the files as listed below; there is no npm
dependency on `@ui-sdk/*` and nothing is fetched at build or run time.

## What is here

- `core/`: from `packages/core/src`, only the transitive imports of the React
  entries below (kernel, popups, lists, focus, platform, text, forms, motion,
  selection, shortcuts, and the menu, menubar, tabs, dialog, listbox, select,
  combobox, field, switch, radio components they reach).
- `react/`: from `packages/react/src`: `menu`, `tabs`, `dialog`, `listbox`,
  `select`, `switch`, `radio` and their helpers.
- `apps/desktop/tests/ui-kit-testing/testing/`: `checkPattern` and its helpers
  from `packages/core/src/testing`, test-only.

## What was removed

- The agent and WebMCP layer: `page/agent` (the agent bridge, its tool list
  and its registration with the browser's model context API), `page/observe`,
  `page/history`, `react/src/agent.ts`, `observe.ts`, `history.ts`, and the
  agent mark attributes with their development warning (`checkMarks`).
- The agent hooks inside the kernel, deleted rather than stubbed: the
  `agent: { … }` keys in every `definePrimitive` call (tabs, listbox, switch,
  field, field-set, menubar, dialog, combobox, menu, radio, select), the
  `agent` definition option and its development check in `primitive.ts`, the
  `AgentSurface` type, the `"agent"` change source, and `kernel/watchers.ts`
  (the global hook through which the agent and `observe` heard every instance)
  with its call sites in `primitive.ts`, `change.ts`, `input-source.ts` and
  `combobox-api.ts`.
- `web.css` and every default look; Pegasus keeps its own tokens, glass and type.
- The Vue, Svelte, Solid and web-components adapters.
- Components Pegasus does not use, `testing/mount.ts` (it reads the observe
  registry), `check-server`, `check-direction`, and the ui-sdk development
  build (`#dev` and `#name-check` always resolve to their production stubs).
- The skills for developing ui-sdk itself (write-code, write-docs,
  expert-review). Pegasus's own rules are in `.agents/skills/ui-kit/SKILL.md`.

## Other changes

- Package imports (`@ui-sdk/core`, `@ui-sdk/core/<entry>`, `#dev`,
  `#name-check`) are rewritten to relative paths, barrel imports split per
  source module.
- Non-null assertions (`!`) and two destructuring defaults where Pegasus's
  `noUncheckedIndexedAccess` reports an indexed read; behavior is unchanged.
