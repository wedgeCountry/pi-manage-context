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
| `/manage_context` (alias `/mc`) | Open the interactive picker |
| `/manage_context auto [focus]` (alias `/mc auto [focus]`) | Run the `context-autoselect` subagent right away (no picker), optionally with a focus description; unselected units are hidden on the next model turn |
| `/manage_context <provider>/<modelId>` | Set the compression model, then open the picker |
| `/manage_context model` | Print the configured compression model |
| `/manage_context config` (alias `/mc config`) | Interactive context-window dialogue: one mode (`off`/`tool`/`assistant`/`user`) + a window N |
| `/manage_context config off` | Disable context-window filtering for this session |
| `/manage_context config <tool\|assistant\|user> <N>` | Set the window directly: keep only the latest N units per kind of that category |
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

## Context window limiting

`/mc config` sets a single window limit: a **mode** (`tool`, `assistant` or
`user`) and a **window** N. While active, only the latest N units *per message
kind* of that category reach the model — tool = tool-call units, assistant =
assistant messages + tool calls, user = all of those + user messages. Older
units of those kinds are hidden automatically in the `context` hook; the
exclusion is ephemeral and never persisted as a mark. Manual marks always win:
unselected/deleted stay hidden even inside the window, and manually selecting
a greyed row pins it above the cap. In the picker, the header shows the active
window (`window: assistant ≤ 10`) and out-of-window rows are greyed with a
`(window)` tag.

The default can be set in `~/.pi/agent/settings.json` (`null` = off):

```json
{ "manage-context": { "mode": "assistant", "window": 10 } }
```

`/mc config` overrides the file for the session.

## Agent tools

| Tool | Purpose |
|---|---|
| `view_context` | Readable overview of the context: `format` = `summary` (default) / `detailed` / `llm-json` |
| `context-select` | Mark turn units `selected` by `groupIds` (empty array = no-op) |
| `context-unselect` | Mark turn units `unselected` by `groupIds` (empty array = no-op) |
| `context-autoselect` | Spawn a subagent (its only tool is `context-unselect`) that unselects irrelevant/outdated units; `focus` describes the current task, `dryRun` (default `false`) reports without persisting |

Matching is groupId-only. Unselected units are hidden from the model on its
next turn but can be re-selected; they are not deleted.

## Customizing the autoselect subagent prompt

The instruction given to the `context-autoselect` subagent lives in its own
editable file, [`prompts/context-autoselect.md`](prompts/context-autoselect.md),
which is read at runtime — edit it and the change applies on the next run, no
rebuild needed. It contains `{{focus}}` and `{{listing}}` placeholders that are
filled in with the current task focus and the JSON listing of turn units.

To override the prompt for a single project, place your own template at
`.pi/context-autoselect.md` in the project directory; it takes precedence over
the bundled file.

## Architecture

See [architecture.md](architecture.md) for the design decisions (turn units,
marks, the context filter, MVVM picker). Run `npm test` and `npm run typecheck`
for verification.
