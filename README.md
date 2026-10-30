# pi-manage-context

A pi extension to review, select, compress, or delete parts of the conversation
context during a session — either interactively or by the agent itself.

## Install

```bash
pi install git:github.com/wedgeCountry/pi-manage-context.git          # project
pi install --global git:github.com/wedgeCountry/pi-manage-context.git # global
```

## Commands

| Command | Description |
|---|---|
| `/manage_context` | Open the interactive picker |
| `/manage_context <provider>/<modelId>` | Set the compression model, then open the picker |
| `/manage_context model` | Print the configured compression model |
| `/export_context [filename.md]` | Export the summarized context as markdown (timestamped name if omitted) |
| `/toggle-read-hook` | Toggle auto-unselecting earlier `read()` results of the same file (default: off) |

## Picker keys

| Key | Action |
|---|---|
| ↑/↓, PageUp/PageDown | Navigate |
| Space / `c` / `d` | Toggle unselected / compressed / deleted |
| →, Enter | Open preview pane |
| Enter (in list) | Apply marks (asks for confirmation when deleting/compressing) |
| Esc / Ctrl+C | Cancel |

Inside the preview: ↑/↓/PageUp/PageDown scroll, →/Home/End horizontal scroll,
`m` toggles compact/detailed, ← or Enter closes.

Deletion is permanent. Compression replaces the original entries with an
LLM-generated summary. Deleted entries never reappear — not in the picker, the
export, or the model's context.

## Agent tools

| Tool | Purpose |
|---|---|
| `view_context` | Readable overview of the context: `format` = `summary` (default) / `detailed` / `llm-json`; `includeDeleted` (default `false`) |
| `manage-context` | `action` = `list` / `select` / `unselect`, matched by `textMatch` (heading, message text, tool call name/args/result) and/or `groupIds` |
| `manage_context_select` | Legacy alias of `manage-context`, same behavior |

Unselected units are hidden from the model on its next turn but can be
re-selected; they are not deleted.

## Architecture

See [architecture.md](architecture.md) for the design decisions (turn units,
marks, the context filter, MVVM picker). Run `npm test` and `npm run typecheck`
for verification.
