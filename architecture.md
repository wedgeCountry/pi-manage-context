# Architecture

pi-manage-context is a pi extension that lets a human (via the `/manage_context`
picker) or the model itself (via tools) review, select, unselect, compress, or
delete turn units before they are sent to the model.

## Core concept: turn units

The atomic manageable row is a **turn unit** (`src/turn-units.ts`): one user
message, one tool-call-free assistant message, one custom message, or one
assistant message that made tool calls *together with* every tool result those
calls produced. All entries in a unit are marked together, as a single row —
this keeps every provider's tool_use/tool_result pairing valid.

Two build levels exist for a reason: `buildTurnUnitGroups()` is cheap and
structural, used on the `"context"` hot path (fires on every LLM call);
`buildTurnUnits()` adds display metadata for the picker, tools, and export.

## Marks and the filter

Four marks: `selected` / `unselected` / `compressed` / `deleted`. State is
persisted as full snapshots in an append-only custom session entry
(`src/state.ts`), version-migrated on load, and pruned of dead marks.

The `"context"` event (`src/hooks.ts`) rebuilds the outgoing message array via
`buildFilteredMessages()` (`src/context-filter.ts`): unselected/deleted units
are dropped; units with realized `compressedText` are served as their summary.
When nothing is marked, all grouping work is skipped.

A realized compression stores `compressedText` and resets the raw mark to
`selected`; the *effective* status still reads as `compressed`. Every surface
(picker, both tools, filter) must report through `markStatus()` /
`describeMark()` (`src/mark-status.ts`) — the single source of truth — never
by re-deriving it. Row glyphs likewise come from the one exported
`symbolForMark()`; renderers only add theme color.

Surfaces that list "what's still in context" (picker, context tools, export)
all go through `visibleTurnUnits()` (`src/turn-units.ts`) — the single
"not deleted" predicate built on `describeMark()`.

## Layering

- `index.ts` — pure wiring only: registers hooks, tools, commands.
- `src/hooks.ts` — session event handlers (`context`, two `tool_result`
  auto-unselect hooks) and the pure unit matchers.
- `src/commands.ts` — the three slash commands.
- Tools follow the pi-small-models pattern: `src/tool_definitions/<tool>.ts`
  holds the pure static definition (name, label, description, typebox
  schema), and `src/tools/createTool.ts` provides the shared factory —
  `createTool(definition, { execute(params, { signal, ctx }) })` spreads the
  definition and adapts pi's 5-arg `execute(toolCallId, params, signal,
  onUpdate, ctx)` into a 2-arg hook, so no tool repeats framework plumbing.
  Each `src/tools/<tool>.ts` keeps a plain, `ExtensionContext`-free function
  (unit-tested directly) plus a thin `buildXTool(pi)` / `registerXTool(pi)`.
  The context-marking tools are `context-select` / `context-unselect` — one
  shared adapter (`buildContextMarkTool()` over the pure `runContextMark()`)
  and one shared definition factory (`makeMarkToolDefinition()` in
  `src/tool_definitions/context-mark.ts`, registered via
  `registerContextMarkTools(pi)`), both in `src/tools/context-mark.ts` —
  plus `context-autoselect` (adapter over `runAutoSelect()` in
  `src/tools/context-autoselect-engine.ts`).
- The picker is MVVM: `src/picker/picker-view-model.ts` owns all state and
  behavior (phase machine, key dispatch, compression orchestration) with no
  TUI imports and `handleInput()` returning `"render" | "close"`;
  `src/view.ts` is render-only; `src/picker/picker-config.ts` holds the layout
  knobs; `src/services/` (`state-service`, `compression-service`) are the
  injected persistence/LLM boundaries. The view-model is tested without a TUI.
- Supporting pure modules: `marks-controller` (mark transitions),
  `compression-queue` (sequential compression with an injected compress fn),
  `llm-export` / `markdown-export` (output formats).

## Key decisions

- **Deletion is permanent by design.** The session file is append-only and pi
  offers no API to strike bytes from it, but nothing in the extension ever
  surfaces a deleted unit again (hidden from picker, tools, export, and the
  model's context). Auto-unselect hooks never resurrect a deletion.
- **Auto-unselect of the extension's own tool call.** The context tools'
  own call+result are hidden after running (only the latest one), otherwise
  every later turn would re-send the call meant to shrink the context. A
  read() tool_result hook can likewise unselect a marked read unit (opt-in
  via `/toggle-read-hook`). Both refuse to match turns bundling other tool
  calls, to avoid collateral hiding.
- **Honest, cheap metadata only.** Turn units carry heading, type, timestamp,
  tool calls, and a capped summary — no importance scores or extracted "key
  facts" (regex heuristics whose fabricated numbers leaked into LLM-facing
  output and steered retention worse than no numbers). Anything score-like is
  computed at compression time with a real LLM call.
- **Compression is picker-only.** The context tools deliberately expose only
  select/unselect (plus autoselect, which can only unselect): compression
  costs an extra LLM call and deletion is irreversible, so both stay behind
  human confirmation. Tool-written marks are picked up by the `"context"`
  handler on the very next model call — no separate apply step.
- **Three single-action tools, groupId-only matching.** `context-select` /
  `context-unselect` / `context-autoselect` replace the combined
  `manage-context` tool; matching is by `groupId` only (no `textMatch`), and
  an empty `groupIds` array is a no-op. `context-autoselect` spawns an
  in-process subagent via `createAgentSession` whose entire toolset is
  `context-unselect` (no extensions/skills/built-ins), so it can hide units
  but never select, compress, or delete them; the latest user turn is never
  offered to it, and `dryRun: true` reports without persisting. All three
  tools are `executionMode: "sequential"` because they do load-modify-save
  on the shared state snapshot — concurrent execution within one assistant
  turn would let the last `saveState` clobber the other's marks (autoselect's
  multi-second subagent run makes that window large). The subagent's child
  tool re-loads state per call for the same reason. An aborted or failed
  autoselect run keeps any marks already persisted — there is no rollback,
  matching the "persist immediately" semantics of the model calling
  `context-unselect` itself.

## Tests

`npm test` runs offline. Plain-function tests (`tests/*-plain.test.ts`,
`tests/picker-view-model.test.ts`) call domain functions directly with
hand-built fixtures; integration tests drive tools via mocked
`ExtensionContext`. Shared session-entry factories and the in-memory pi
stand-in live in `tests/helpers.ts`. Provider-dependent tests auto-skip
without API keys.
