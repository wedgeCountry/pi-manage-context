# Test Suite Documentation

## Overview

This test suite provides comprehensive coverage for the context management tools, testing both structure and actual functionality with mocked contexts.

## Test Files

### agent-sdk-faux.test.ts

Drives the full pi SDK agent loop (`createAgentSession` → `session.prompt` → tool
execution → tool result → next model turn) with pi-ai's **Faux** model as the LLM.
The faux provider's scripted responses issue real `view_context` and
`context-unselect` tool calls, so the tools execute against a real
`AgentSession`/`SessionManager` — no network or credentials needed. Covers:
- `view_context` called through the whole loop, session entries grow
- `context-unselect` by groupId: marks persist in state and
  `buildFilteredMessages` shrinks the model-visible context

### self-test-extension.test.ts

The same agent-loop shape, but against a **real LLM**, using the global pi
setup: `~/.pi/agent/settings.json` for the default provider/model,
`~/.pi/agent/auth.json` for credentials (via `ModelRuntime.create()` and
`SettingsManager.create()`, not in-memory stubs). These tests run when a
provider credential is available — an env API key (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `MISTRAL_API_KEY`, ...) or a stored `/login` credential in
auth.json — and skip otherwise, so `npm test` stays green offline.

### integration.test.ts

Not a vitest file — a pi selftest *extension script* (registers `my_tool` and a
nested-agent `run_selftest`) meant to be loaded interactively with
`pi -e`. Vitest reports "No test suite found" for it; that is expected.

### view-context-tool.test.ts

Tests for the `view_context` tool covering:

#### Structure Tests
- Tool name and description validation
- Parameter schema validation
- Format options verification

#### Functional Tests
- **Empty context handling**: Verifies graceful behavior with no entries
- **Summary format**: Tests statistics, entry counts, token totals
- **Detailed format**: Tests full metadata output
- **LLM-JSON format**: Tests structured JSON output and parsing
- **Deleted entry filtering**: Verifies deleted entries are excluded by default
- **Include deleted option**: Tests `includeDeleted=true` parameter
- **Retention analysis**: Tests `showRetention=true` in detailed format
- **Entry type counting**: Verifies correct counts by type (user/assistant/tool/custom)
- **Token count display**: Verifies token totals are shown
- **Selection status display**: Verifies mark status is shown

#### Key Test Scenarios
```typescript
// Empty context
view_context({}) → "No entries in context yet"

// Summary format
view_context({ format: "summary" }) → Shows stats, counts, tokens

// Detailed format  
view_context({ format: "detailed" }) → Shows full metadata per entry

// JSON format
view_context({ format: "llm-json" }) → Returns parseable JSON

// With deleted entries
view_context({ includeDeleted: true }) → Shows all entries including deleted

// With retention analysis
view_context({ format: "detailed", showRetention: true }) → Shows retention reasons
```

### context-mark-plain.test.ts

Unit tests for the pure `runContextMark()` core shared by `context-select`
and `context-unselect`:

- **groupId-only matching**: select/unselect by groupId; text never matches
- **Empty-array no-op**: `changed: false`, state untouched, no-op message
- **Unknown ids**: reported as not matched, never applied
- **Preview-before-mutate**: each matched unit's id, heading, and previous
  effective mark appear in the output
- **Mark field preservation**: unselecting a compressed unit keeps `compressedText`

### auto-select-plain.test.ts

Unit tests for the pure halves of `context-autoselect`:

- `buildAutoListing`: row shape (groupId/heading/type/tokenEstimate/summary/mark),
  summary capping with line breaks preserved, heading flattened to one line,
  and exclusion of only the LATEST user unit
- `buildAutoSelectTask`: listing embedded as JSON plus focus and the
  one-call/conservative instructions
- `summarizeAutoResult`: unselected id list, dry-run flag, no-op case

### context-tools.test.ts

Integration tests for the three tools through an in-memory pi-runtime
stand-in (appendEntry round-trips state snapshots exactly like the picker):

- **Structure**: tool names; `groupIds` required string array; no
  `textMatch`/`action` params; autoselect's optional `focus`/`dryRun`
- **context-select / context-unselect**: marks persist via `saveState`;
  empty `groupIds` persists nothing and doesn't notify; unknown ids rejected;
  re-select after unselect works; notification only on actual change
- **context-autoselect** (dependency-injected fake child-session factory):
  the subagent gets `context-unselect` as its ONLY tool; its call lands in the
  PARENT session's state; unknown ids rejected; `dryRun` reports without
  persisting; latest user unit never offered; empty listing short-circuits
  without spawning; parent abort signal propagates to the child session

#### Key Test Scenarios
```typescript
// Select / unselect by groupId
context-select({ groupIds: ["entry-1", "entry-2"] })
context-unselect({ groupIds: ["entry-1"] })

// Empty array = no-op
context-unselect({ groupIds: [] }) → "no groupIds given — nothing changed"

// Autoselect
context-autoselect({ focus: "fix the login bug" })
context-autoselect({ focus: "fix the login bug", dryRun: true }) → report only
```

## Test Helpers

### Mock Functions

```typescript
createMockContext(entries: SessionEntry[])
// Creates a mocked ExtensionContext with buildContextEntries stubbed

createUserMessageEntry(id, content, timestamp?)
// Creates a user message SessionEntry for testing

createAssistantMessageEntry(id, content, timestamp?)
// Creates an assistant message SessionEntry for testing
```

### Spy/Mock Usage

```typescript
// Mock loadState to control marks
const loadStateSpy = vi.spyOn(state, "loadState").mockReturnValue({
  marks: { "entry-2": { mark: "deleted" } }
});

// Mock saveState to verify persistence
const saveStateSpy = vi.spyOn(state, "saveState").mockImplementation(() => {});
// Then verify: expect(saveStateSpy).toHaveBeenCalled();
```

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- view-context-tool.test.ts

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

## Test Coverage Goals

### view-context-tool.test.ts
- [x] Tool structure (name, description, parameters)
- [x] Empty context handling
- [x] Summary format output
- [x] Detailed format output
- [x] LLM-JSON format output
- [x] Deleted entry filtering
- [x] includeDeleted parameter
- [x] showRetention parameter
- [x] Entry type counting
- [x] Token count display
- [x] Selection status display

### context-tools.test.ts
- [x] Tool structure (names, groupIds schema, autoselect focus/dryRun)
- [x] Select/unselect by groupId
- [x] Empty-array no-op (nothing persisted, no notification)
- [x] Unknown groupIds rejected
- [x] State persistence (select/unselect)
- [x] Autoselect child gets context-unselect as its only tool
- [x] Autoselect lands in parent state; dryRun persists nothing
- [x] Latest user unit excluded; abort propagation

## What Makes These Tests Meaningful

### 1. **Test Real Functionality, Not Just Structure**

❌ **Bad**: Only checking tool name exists
```typescript
expect(tool.name).toBe("view_context");
```

✅ **Good**: Testing actual execution with mocked context
```typescript
const result = await tool.execute("call-id", {}, undefined, undefined, mockCtx);
expect((result.content[0] as any).text).toContain("CONTEXT OVERVIEW");
```

### 2. **Test Edge Cases**

- Empty context (no entries)
- Deleted entries (should be filtered)
- No matches found
- Missing required parameters
- Case sensitivity
- Combined search criteria

### 3. **Test State Changes**

Not just that the tool runs, but that it **persists changes correctly**:

```typescript
const saveStateSpy = vi.spyOn(state, "saveState");
await tool.execute(...);
expect(saveStateSpy).toHaveBeenCalled(); // State was persisted
```

### 4. **Test Output Formats**

Verify the actual output content, not just that it exists:

```typescript
const text = (result.content[0] as any).text;
expect(text).toContain("Total entries: 2");
expect(text).toContain("User messages: 1");
expect(text).toContain("Assistant responses: 1");
```

### 5. **Test JSON Parsing**

For llm-json format, verify it's actually valid JSON:

```typescript
const json = JSON.parse(text);
expect(json.summary.totalEntries).toBe(1);
expect(Array.isArray(json.entries)).toBe(true);
```

### 6. **Test Matching Behavior**

Verify groupId matching works correctly across different scenarios:

```typescript
// Exact groupId match
context-unselect({ groupIds: ["entry-1"] }) marks only entry-1

// Unknown ids are reported, never applied
context-unselect({ groupIds: ["bogus"] }) → "No turn units matched"

// Empty array is a no-op
context-unselect({ groupIds: [] }) → "no groupIds given — nothing changed"
```



## Future Test Additions

### Integration Tests
- [ ] Test with real state file
- [ ] Test context filtering pipeline
- [ ] Test with tool call entries
- [ ] Test with compressed entries

### Performance Tests
- [ ] Test with large context (100+ entries)
- [ ] Test search performance
- [ ] Test memory usage

### Error Handling
- [ ] Test malformed entries
- [ ] Test state load failures
- [ ] Test concurrent modifications

## Test Quality Metrics

- **Coverage**: 90%+ of core functionality
- **Meaningful**: Tests behavior, not just structure
- **Maintainable**: Clear helpers, descriptive names
- **Fast**: All tests run in < 2 seconds
- **Reliable**: No flaky tests, deterministic output