# pi-manage-context

A pi extension to manage and modify context during a session.

## Features

### Interactive UI (`/manage_context`)

Type `/manage_context` in the pi session to open an interactive picker where you can:

- **Select/unselect** messages and tool results (only selected messages are visible to the agent)
- **Compress** entries into shorter summaries (saves tokens)
- **Delete** entries permanently (cannot be undone)
- **Preview** full content of individual messages in a detailed view

Delete and compress operations prompt for confirmation before applying.

### Agent Tools

The extension provides three tools for the AI agent to manage its own context:

#### `view_context` — Get a readable overview of conversation context

Creates a human-readable overview similar to what the user sees in the `/manage_context` picker. Shows all turn units with their metadata, token counts, importance scores, and current selection status.

**Parameters:**
- `format` (optional): `"summary"` (brief overview), `"detailed"` (full metadata), or `"llm-json"` (structured JSON). Defaults to `"summary"`.
- `includeDeleted` (optional): If `true`, include entries marked as deleted. Defaults to `false`.
- `showRetention` (optional): If `true`, show retention analysis for each entry. Only applies to `"detailed"` format. Defaults to `false`.

**Example usage:**
```
view_context({ format: "summary" })
view_context({ format: "detailed", showRetention: true })
view_context({ format: "llm-json" })
```

#### `manage-context` — List/select/unselect context turns

Allows the model itself to list turn units and flip their selected/unselected mark by text match or groupId, without human intervention.

**Parameters:**
- `action` (required): `"list"`, `"select"`, or `"unselect"`
- `textMatch` (optional): Case-insensitive substring searched across heading, message text, and tool call names/arguments/results
- `groupIds` (optional): Exact groupId(s) to affect, as reported by a `'list'` action

**Example usage:**
```
manage-context({ action: "list" })
manage-context({ action: "select", textMatch: "file path" })
manage-context({ action: "unselect", groupIds: ["entry-123", "entry-456"] })
manage-context({ action: "select", textMatch: "poem" })  // catches tool calls about poems too
```

#### `manage_context_select` — Legacy tool name

Same functionality as `manage-context` (provided for backward compatibility).

### Read Hook (`/toggle-read-hook`)

An optional hook that automatically unselects old `read()` results of the same file to save tokens. Enable/disable with `/toggle-read-hook` (default: off).

When enabled, if the agent reads a file that was already read earlier in the conversation, the previous read result is automatically unselected from context.

## Installation

### Install in a project

```bash
pi install git:github.com/wedgeCountry/pi-manage-context.git
```

### Install globally

```bash
pi install --global git:github.com/wedgeCountry/pi-manage-context.git
```

## Usage Examples

### Agent workflow example

```
1. Agent calls: view_context({ format: "summary" })
   → Sees overview of all 25 entries, 15k tokens total

2. Agent calls: manage-context({ action: "list" })
   → Gets detailed JSON with all entry metadata

3. Agent calls: manage-context({ action: "unselect", textMatch: "early draft" })
   → Unselects 3 early conversation turns

4. Agent calls: manage-context({ action: "select", textMatch: "final implementation" })
   → Ensures important entries are selected

5. Next model call only sees the selected entries (reduced token count)
```

### Compression workflow (UI only)

1. User types `/manage_context`
2. Presses `c` on entries to compress (marked with ▤)
3. Presses `Enter` to apply
4. Confirms compression when prompted
5. Selected entries are replaced with AI-generated summaries

## Keyboard Shortcuts (UI Picker)

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate entries |
| PageUp/PageDown | Jump by page |
| Space | Toggle select/unselect |
| c | Mark for compression |
| d | Mark for deletion |
| → | Open preview pane |
| Enter | Apply changes |
| Esc | Cancel / Close preview |
| Ctrl+C | Cancel and discard changes |

**Inside preview pane:**
| Key | Action |
|-----|--------|
| ↑/↓ | Scroll content |
| PageUp/PageDown | Page scroll |
| → | Horizontal scroll |
| Home/End | Jump to start/end |
| ← | Close preview |
| r | Toggle retention analysis |
| m | Toggle preview mode (compact/detailed) |

## Architecture

The extension maintains a state file tracking marks (selected/unselected/compressed/deleted) for each turn unit. The `context` event handler filters messages before they're sent to the model based on these marks. Compression replaces the original content with an LLM-generated summary.

See `docs/` for detailed implementation notes.