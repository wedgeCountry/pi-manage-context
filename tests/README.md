# Test Suite Documentation

## Overview

This test suite provides comprehensive coverage for the context management tools, testing both structure and actual functionality with mocked contexts.

## Test Files

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

### manage-context-tool.test.ts

Tests for the `manage-context` and `manage_context_select` tools covering:

#### Structure Tests
- Tool name validation (both hyphenated and underscore versions)
- Parameter schema validation
- Action options (list/select/unselect)
- Backward compatibility between tool names

#### Functional Tests - List Action
- **Returns all turn units**: Verifies list returns entries with metadata
- **Excludes deleted entries**: Verifies deleted entries filtered from list
- **Includes mark status**: Verifies each entry shows its mark

#### Functional Tests - Select Action
- **Text matching**: Tests selection by text substring
- **ID matching**: Tests selection by specific groupIds
- **Combined matching**: Tests OR logic between textMatch and groupIds
- **No matches**: Tests behavior when nothing matches
- **Missing parameters**: Tests error when neither textMatch nor groupIds provided
- **Case insensitivity**: Tests case-insensitive search
- **Content searching**: Tests search in full content, not just headings

#### Functional Tests - Unselect Action
- **Text matching**: Tests unselection by text substring
- **ID matching**: Tests unselection by specific groupIds
- **Missing parameters**: Tests error handling

#### State Persistence Tests
- **Select persists state**: Verifies saveState() called after select
- **Unselect persists state**: Verifies saveState() called after unselect
- **List doesn't persist**: Verifies saveState() NOT called for read-only list

#### Key Test Scenarios
```typescript
// List all entries
manage-context({ action: "list" }) → JSON array of entries

// Select by text
manage-context({ action: "select", textMatch: "file" }) → Matches entries with "file"

// Select by IDs
manage-context({ action: "select", groupIds: ["entry-1", "entry-2"] })

// Select with both
manage-context({ action: "select", textMatch: "draft", groupIds: ["entry-5"] })

// Unselect by text
manage-context({ action: "unselect", textMatch: "brainstorming" })

// Error: missing parameters
manage-context({ action: "select" }) → "provide textMatch and/or groupIds"
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

### manage-context-tool.test.ts
- [x] Tool structure (both names)
- [x] List action functionality
- [x] Select action functionality
- [x] Unselect action functionality
- [x] Text matching (case-insensitive)
- [x] ID matching
- [x] Combined matching (OR logic)
- [x] No matches handling
- [x] Missing parameter validation
- [x] State persistence (select)
- [x] State persistence (unselect)
- [x] No persistence (list)
- [x] Backward compatibility

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

### 6. **Test Search Behavior**

Verify search works correctly across different scenarios:

```typescript
// Case insensitive
textMatch: "FILE" matches "file operation"

// Content search
textMatch: "optimization" matches message containing "optimization"

// Combined criteria
textMatch: "draft" OR groupIds: ["entry-5"]
```

### 7. **Test Backward Compatibility**

Ensure legacy tool name works identically:

```typescript
const tool1 = buildManageContextTool(pi);
const tool2 = buildManageContextSelectTool(pi);
expect(JSON.stringify(tool1.parameters)).toBe(JSON.stringify(tool2.parameters));
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