# Implementation plan: split `manage-context` into `context-select` / `context-unselect` / `context-autoselect`

Self-contained plan. No prior context required beyond this file and the repo.

## 1. Goal

Replace the single `manage-context` tool (actions `list`/`select`/`unselect` matched by
`textMatch` and/or `groupIds`) with three dedicated tools:

| Tool | Params | Behavior |
|---|---|---|
| `context-select` | `groupIds: string[]` (may be empty) | Empty array → no-op ("nothing matched"). Otherwise mark those turn units `selected`. |
| `context-unselect` | `groupIds: string[]` (may be empty) | Empty array → no-op. Otherwise mark those turn units `unselected`. |
| `context-autoselect` | `focus?: string`, `dryRun?: boolean` (default `false`) | Spawn an in-process subagent that reviews all turn units and unselects irrelevant/outdated ones by groupId. |

Matching is **groupId-only** — `textMatch` is removed entirely.

`context-autoselect`'s subagent has **`context-unselect` as its only tool** (no list, no
select, no compress/delete, no built-in tools).

## 2. Background / research findings

- Turn units (`src/turn-units.ts`) already carry a unique `groupId` (the anchor session
  entry's id). No new identifier scheme is needed.
- Marks persist as append-only snapshots in the parent session via
  `saveState(pi, state)` (`src/state.ts:96`); the `"context"` hook
  (`src/hooks.ts` → `buildFilteredMessages()` in `src/context-filter.ts`) applies them on
  the next model call. Tool-written marks need no separate apply step.
- The official pi subagent example
  (`earendil-works/pi` `packages/coding-agent/examples/extensions/subagent`) spawns a
  **separate `pi` process** (`pi --mode json -p --no-session`). Such a child cannot call
  the parent's tools or write parent state — wrong fit here.
- The right mechanism is an **in-process subagent** via the SDK exported by
  `@earendil-works/pi-coding-agent`:
  `createAgentSession({ sessionManager: SessionManager.inMemory(), model, customTools, resourceLoader })`,
  then `session.prompt(task)`, `session.subscribe(...)`, `session.abort()`, `session.dispose()`.
  Because it runs in the same process, a tool registered on the child via `customTools`
  can close over the **parent's** `ExtensionAPI` (`pi`) and `ExtensionContext` (`ctx`) and
  mutate the **parent** session's state. Passing a resource loader with
  `noExtensions: true, noSkills: true` and no built-in tools means `customTools` is the
  child's entire toolset.

## 3. Confirmed decisions

- Subagent model: inherit the main session's model (`ctx.model`).
- Apply mode: unselects persist immediately (same semantics as the model calling
  `context-unselect` itself); `dryRun: true` reports the chosen ids without persisting.
- Identifiers: reuse existing `groupId`.
- Spawn mode: in-process `createAgentSession`, not a subprocess.
- `context-select`/`context-unselect` accept an **empty** `groupIds` array → tool does
  nothing and says so.

## 4. File-by-file changes

### 4.1 `src/tool_definitions/context-select.ts` (new)
- `CONTEXT_SELECT_PARAMETERS = Type.Object({ groupIds: Type.Array(Type.String(), { description: ... }) })`
  — required property, but the array may be empty (empty = no-op).
- `CONTEXT_SELECT_TOOL_DEFINITION = { name: "context-select", label: "Select context units", description, promptSnippet, parameters }`.
- Description: ids are the `groupId`s shown by the `/manage_context` picker or reported
  by `context-autoselect`; empty array does nothing.

### 4.2 `src/tool_definitions/context-unselect.ts` (new)
- Same shape: `groupIds: string[]`, name `"context-unselect"`. Description notes
  unselected units are hidden from context on the next turn but not deleted and can be
  re-selected with `context-select`.

### 4.3 `src/tool_definitions/context-autoselect.ts` (new)
- `CONTEXT_AUTOSELECT_PARAMETERS = Type.Object({ focus: Type.Optional(Type.String({ description: "What the current task is about, so the subagent can judge relevance." })), dryRun: Type.Optional(Type.Boolean({ description: "Report the chosen groupIds without persisting. Defaults to false." })) })`.
- Name `"context-autoselect"`; description explains it delegates relevance judgment to a
  subagent whose only tool is `context-unselect`.

### 4.4 `src/tools/context-mark.ts` (new, pure logic)
- `runContextMark(units: TurnUnit[], state: ManageContextState, groupIds: string[], action: "select" | "unselect", toolName: string): { content: [{ type: "text"; text: string }]; details: unknown; changed: boolean }`
  - If `groupIds.length === 0` → return "No groupIds given — nothing changed.", `changed: false` (no-op).
  - Match **only** by `unit.groupId` (`groupIds.includes(unit.groupId)`). No text matching.
  - Unknown ids (in `groupIds` but not among units) are reported as not matched.
  - Report each matched unit (id, one-line heading, previous effective mark via
    `describeMark`) **before** mutating, then set `state.marks[unit.groupId] = { ...existing, mark: targetMark }`.
  - `details` = affected groupIds; `changed` = whether any mark was written.
- Delete `unitSearchText` / `unitMatches` / the `textMatch` param from the old
  `src/tools/manage-context.ts`.

### 4.5 `src/tools/context-select.ts` and `src/tools/context-unselect.ts` (new, thin adapters)
Pattern copied from the current `buildManageContextToolImpl` (`src/tools/manage-context.ts`):
```ts
async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
	const entries = ctx.sessionManager.buildContextEntries();
	const state = loadState(ctx);
	const units = buildTurnUnits(entries).filter((u) => describeMark(u, state).effective !== "deleted");
	const result = runContextMark(units, state, params.groupIds, "select" | "unselect", definition.name);
	if (result.changed) {
		saveState(pi, state);
		ctx.ui.notify(`${definition.name}: ${result.content[0].text.split("\n")[0]}`, "info");
	}
	return { content: result.content, details: result.details };
}
```
Each exports `buildContextSelectTool(pi)` / `registerContextSelectTool(pi)` (and the
unselect equivalents).

### 4.6 `src/tools/auto-select.ts` (new)
Two halves, following the repo's pure-function + adapter split:

- Pure: `buildAutoListing(units: TurnUnit[], state: ManageContextState): Array<{ groupId, heading, type, tokenEstimate, summary, mark }>`
  — compact rows for the subagent prompt, capped via `oneLine`/`preserveLineBreaks`,
  mark via `describeMark`, **excluding the latest `user` unit** (never offer it for
  unselection).
- Pure: `summarizeAutoResult(...)` — tool-result text for the parent model.
- Adapter: `runAutoSelect(pi, ctx, units, state, params: { focus?: string; dryRun?: boolean }, signal: AbortSignal)`:
  1. `listing = buildAutoListing(units, state)`.
  2. Child tool = the real `context-unselect` tool definition whose `execute` closes over
     the **parent** `pi` + `ctx`: it validates ids against the known units, applies
     `runContextMark(units, state, groupIds, "unselect", "context-unselect")`, and calls
     `saveState(pi, state)` on the parent session — skipped under `dryRun`, which records
     the ids in a local array instead.
  3. `const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory(), model: ctx.model, customTools: [childContextUnselectTool], resourceLoader: <DefaultResourceLoader with noExtensions/noSkills/no context> });`
  4. Task prompt: the listing as JSON + `focus`; instruct: call `context-unselect` **once**
     with the `groupIds` of units that are irrelevant or outdated for the current task; be
     conservative; the latest user turn is not in the list and must not be referenced.
  5. Wire the parent tool call's `signal` to `session.abort()`; `await session.prompt(task)`;
     then `session.dispose()`. The child's `context-unselect` result `details`
     (affected groupIds) is the structured outcome.
  6. Return `{ content, details: { unselected: string[], dryRun: boolean } }`.

### 4.7 `src/tools/context-autoselect.ts` (new, thin adapter)
Like 4.5: builds units+state, delegates to `runAutoSelect`, notifies via `ctx.ui.notify`.
Exports `buildContextAutoselectTool(pi)` / `registerContextAutoselectTool(pi)`.

### 4.8 Delete `src/tool_definitions/manage-context.ts` and `src/tools/manage-context.ts`
The combined `manage-context` tool and its legacy alias are removed.

### 4.9 `index.ts`
Replace `registerManageContextTool(pi)` with:
```ts
registerContextSelectTool(pi);
registerContextUnselectTool(pi);
registerContextAutoselectTool(pi);
```
Update the header comment tool list.

## 5. Guardrails

- Autoselect can only ever unselect — by construction: the child's whole toolset is
  `customTools: [context-unselect]` with no extensions/skills/built-ins loaded.
- Latest user unit is excluded from the listing offered to the subagent.
- Unknown groupIds are reported, never silently applied.
- Empty `groupIds` on select/unselect is a no-op with `changed: false` (nothing persisted).
- Child turn count capped; parent tool-call abort signal propagates to `session.abort()`.
- `dryRun: true` never calls `saveState`.
- Compression and deletion remain picker-only (human confirmation); unchanged.

## 6. Tests

- Plain (`tests/context-mark-plain.test.ts`): `runContextMark` select/unselect by groupId
  only; **empty-array no-op** (`changed: false`, state untouched); unknown ids reported;
  preview-before-mutate output.
- Plain (`tests/auto-select-plain.test.ts`): `buildAutoListing` shape, caps, mark labels,
  latest-user-unit exclusion; `summarizeAutoResult`.
- Integration (`tests/context-tools.test.ts`, mocked `ExtensionContext` as in
  `tests/manage-context-tool.test.ts`): `context-select`/`context-unselect` persist marks;
  empty array persists nothing.
- Integration for autoselect with a **dependency-injected fake session factory** (same
  pattern as `src/services/compression-service.ts`): assert the child's `context-unselect`
  call lands in parent state; `dryRun` persists nothing; unknown ids rejected.
- Rewrite existing `tests/manage-context-tool.test.ts` / `manage-context-plain.test.ts` for
  the three new tools; delete references to `manage-context`/`textMatch`.
- Provider-dependent paths auto-skip without API keys, per `tests/README.md`.

## 7. Docs

- `architecture.md`: update the layering bullet (tools split) and add a "Key decisions"
  entry: three single-action tools, groupId-only matching, autoselect spawns a subagent
  whose only tool is `context-unselect`, empty groupIds is a no-op.
- `index.ts` header comment and `README.md` tool list updated.

## 8. Verification

- `npm run typecheck` (`tsc --noEmit`)
- `npm test` (`vitest run`, offline)
