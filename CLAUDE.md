# pi-manage-context

A pi extension that lets a human (via the `/manage_context` picker) or the model itself
(via tools) review, select, unselect, compress, or delete turn units before they're sent
to the model.

## Tool pattern

Each LLM-callable tool is split into two files that must stay in sync:

**1. `src/tool_definitions/<tool>.ts`** — pure data, no logic:
- `name`, `label`, `description` — shown to the model in the tool list
- `promptSnippet` — one-liner injected into the model's context about when to use this tool
- `parameters` — a typebox `Type.Object({...})` schema

**2. `src/tools/<tool>.ts`** — three exports:
- A **plain function** (`runManageContext`, `buildContextOverview`, ...) that does the real
  work: takes the `TurnUnit[]`/`ManageContextState` the caller already fetched plus the
  tool params, no `ExtensionContext`/`ExtensionAPI` involved. This is what `tests/*-plain.test.ts`
  calls directly — no mock `sessionManager` needed.
- A **`buildXTool(pi)`** function returning the full `ToolDefinition` (spreads the
  `*_TOOL_DEFINITION`, adds `execute()`), kept because the integration tests under `tests/`
  drive tools this way (`tool.execute(...)` against a mocked `ExtensionContext`).
- A **`registerXTool(pi)`** function — `pi.registerTool(buildXTool(pi))` — this is what
  `index.ts` calls; nothing tool-specific lives in `index.ts` beyond these calls.

`execute()` in `buildXTool` is the only place that touches `ctx.sessionManager`,
`loadState`/`saveState` (see `src/state.ts`), and `buildTurnUnits()` — it resolves those,
calls the plain function, and wraps the result as `{ content: [...], details: {...} }`.

Unlike a filesystem-touching extension, there is no `resolveSandboxPath` step here — these
tools operate on the in-memory session/turn-unit model, not the filesystem, so nothing
needs sandboxing.

### Why the split

- The definition is reusable/inspectable data (schema, prompt copy) kept separate from behavior.
- The plain function is unit-testable without spinning up a mock `ExtensionContext`.
- `buildXTool`/`registerXTool` are the only places touching `ExtensionAPI`/`ExtensionContext`
  and result-shaping — keeping that plumbing out of the core logic.

### One implementation, multiple registered names

`manage-context` is also registered under the legacy name `manage_context_select`. Both
names share one `tool_definitions` base object (spread with a different `name`/`label`) and
one plain function; `src/tools/manage-context.ts` exports `buildManageContextTool(pi)` /
`buildManageContextSelectTool(pi)` and `registerManageContextTool(pi)` /
`registerManageContextSelectTool(pi)` for the two names.

### Checklist for a new tool

- Add `src/tool_definitions/<tool>.ts` (typebox schema + description/promptSnippet).
- Add `src/tools/<tool>.ts` with a plain function operating on `TurnUnit[]`/`ManageContextState`,
  a `buildXTool(pi)`, and a `registerXTool(pi)`.
- Call `registerXTool(pi)` from `index.ts`.
- Add a `tests/<tool>-plain.test.ts` unit test that calls the plain function directly with
  hand-built `TurnUnit`/`ManageContextState` fixtures (see existing `*-plain.test.ts` files
  for the fixture shape).

## Other modules

- `src/state.ts` — persisted extension state (marks, compression model, read-hook toggle),
  stored as a "custom" session entry. Shared by both tools and the interactive picker.
- `src/turn-units.ts` — groups raw session entries into `TurnUnit`s (the atomic row unit).
- `src/context-filter.ts` — applies marks (unselected/compressed) to build the messages
  actually sent to the model; wired into the `"context"` event in `index.ts`.
- `src/view.ts` — the interactive `/manage_context` picker UI (not a tool).
- `src/compression.ts`, `src/llm-export.ts`, `src/markdown-export.ts` — supporting logic used
  by the picker and by the tools' `llm-json`/summary output formats.
