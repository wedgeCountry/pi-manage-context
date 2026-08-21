/**
 * manage-context — review, select, compress, or delete messages before
 * they're sent to the model.
 *
 * Usage:
 *   /manage_context                      open the picker
 *   /manage_context <provider>/<modelId> set the compression model, then open the picker
 *   /manage_context model                print the currently configured compression model
 *   /toggle-read-hook                    toggle the read tool's post-execution hook (default: off)
 *
 * Keys inside the picker:
 *   Up/Down, PageUp/PageDown   navigate
 *   Space                      toggle selected / unselected
 *   c                          toggle "marked for compression"
 *   d                          toggle "marked for deletion"
 *   Enter                      preview the full content of the highlighted row
 *   Esc                        apply the marks (compress/delete) and close;
 *                              if any entries are marked for deletion and/or
 *                              compression, asks for confirmation (y/enter
 *                              confirm, n/esc cancel). Confirmed deletions are
 *                              permanent: gone from the model's context AND
 *                              hidden from this picker for good — there's no
 *                              "undelete". Confirmed compressions replace the
 *                              original messages with the generated summary
 *                              and the entry's state reverts to "selected".
 *   Ctrl+C                     cancel — discard any unsaved marks from this session
 *
 * Install: copy this directory to ~/.pi/agent/extensions/manage-context/
 * (or .pi/extensions/ for a single project). Pi auto-discovers directories
 * with an index.ts entry point.
 *
 * Grounded against @earendil-works/pi-coding-agent, @earendil-works/pi-ai and
 * @earendil-works/pi-tui — see the real .d.ts files shipped with those
 * packages for anything not covered by a comment here.
 */

import { resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	AutocompleteItem,
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	KeybindingsManager,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { isReadToolResult } from "@earendil-works/pi-coding-agent";

import { buildFilteredMessages } from "./src/context-filter.ts";
import { loadState, saveState } from "./src/state.ts";
import { buildTurnUnits, type TurnUnit } from "./src/turn-units.ts";
import { ManageContextView } from "./src/view.ts";
import { buildManageContextSelectTool } from "./src/agent-select-tool.ts";

/**
 * True if `unit` is an assistant turn whose *only* tool call is a read() on
 * `resolvedPath`. Units that bundle other tool calls alongside the read are
 * left alone — unselecting the unit would hide those other calls too, since
 * a mark applies to the whole turn unit, not to one call within it.
 */
export function unitHasMatchingRead(unit: TurnUnit, resolvedPath: string, currentToolCallId: string): boolean {
	if (unit.kind !== "assistant_tool") return false;
	if (unit.anchorEntry.type !== "message" || unit.anchorEntry.message.role !== "assistant") return false;

	const toolCalls = unit.anchorEntry.message.content.filter((block) => block.type === "toolCall");
	if (toolCalls.length !== 1) return false;

	const [toolCall] = toolCalls;
	// Pro-forma: the current call's own unit shouldn't exist in
	// buildContextEntries() yet at this point in the tool_result event, but
	// never unselect the very call that just produced this result if it does.
	if (toolCall.id === currentToolCallId) return false;
	if (toolCall.name !== "read") return false;
	const path = toolCall.arguments.path;
	return typeof path === "string" && resolve(path) === resolvedPath;
}

export default function (pi: ExtensionAPI): void {
	let cachedModels: Model<Api>[] = [];

	pi.on("session_start", async (_event, ctx) => {
		cachedModels = ctx.modelRegistry.getAvailable();
	});

	pi.on("context", (_event: ContextEvent, ctx): ContextEventResult | void => {
		const entries = ctx.sessionManager.buildContextEntries();
		const units = buildTurnUnits(entries);
		const state = loadState(ctx);
		if (Object.keys(state.marks).length === 0) return; // nothing to change
		return { messages: buildFilteredMessages(entries, units, state) };
	});

	pi.on("tool_result", (event: ToolResultEvent, ctx): ToolResultEventResult | void => {
		if (!isReadToolResult(event)) return;
		if (event.isError) return;

		const state = loadState(ctx);
		if (!state.readHookEnabled) return;

		const path = event.input.path;
		if (typeof path !== "string") return;
		const resolvedPath = resolve(path);

		const units = buildTurnUnits(ctx.sessionManager.buildContextEntries());
		let changed = false;
		for (const unit of units) {
			if (!unitHasMatchingRead(unit, resolvedPath, event.toolCallId)) continue;

			// Deletions are permanent by design (see the picker docs above) —
			// never resurrect one into the lesser "unselected" state.
			const mark = state.marks[unit.groupId]?.mark;
			if (mark === "deleted" || mark === "unselected") continue;

			state.marks[unit.groupId] = { mark: "unselected" };
			changed = true;
		}

		if (changed) saveState(pi, state);
	});

	pi.registerTool(buildManageContextSelectTool(pi));

	pi.registerCommand("manage_context", {
		description: "Review, select, compress, or delete messages from the model's context",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			if (cachedModels.length === 0) return null;
			const items = cachedModels.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("manage_context requires an interactive terminal", "warning");
				return;
			}

			const state = loadState(ctx);
			const trimmed = args.trim();

			if (trimmed === "model") {
				const current = state.compressionModel
					? `${state.compressionModel.provider}/${state.compressionModel.id}`
					: ctx.model
						? `${ctx.model.provider}/${ctx.model.id} (default: main chat model)`
						: "(none configured, no main chat model to fall back to)";
				ctx.ui.notify(`Compression model: ${current}`, "info");
				return;
			}

			if (trimmed) {
				const slash = trimmed.indexOf("/");
				const provider = slash === -1 ? "" : trimmed.slice(0, slash);
				const modelId = slash === -1 ? "" : trimmed.slice(slash + 1);
				const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
				if (!model) {
					ctx.ui.notify(`Unknown model "${trimmed}". Use provider/modelId, e.g. anthropic/claude-haiku-4-5.`, "error");
					return;
				}
				state.compressionModel = { provider: model.provider, id: model.id };
				saveState(pi, state);
				ctx.ui.notify(`Compression model set to ${trimmed}`, "success");
			}

			const entries = ctx.sessionManager.buildContextEntries();
			// Confirmed deletions are gone for good from the extension's point of
			// view: never shown again, never sent to the model. (The underlying
			// session file is append-only and still holds the raw entries — pi
			// gives extensions no API to strike bytes from it — but nothing in
			// this extension will ever surface them again.)
			const units = buildTurnUnits(entries).filter((u) => state.marks[u.groupId]?.mark !== "deleted");
			if (units.length === 0) {
				ctx.ui.notify("No messages in context yet.", "info");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb: KeybindingsManager, done) => new ManageContextView(tui, theme, units, state, ctx, pi, done),
				// pi-tui defaults an overlay's width to min(80, availWidth) when no
				// width is given, which clips this picker to 80 columns on wide
				// terminals. Claim most of the terminal instead.
				{ overlay: true, overlayOptions: { width: "95%", minWidth: 60 } },
			);
		},
	});

	pi.registerCommand("toggle-read-hook", {
		description: "Toggle the read tool's post-execution hook on/off (default: off)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const state = loadState(ctx);
			state.readHookEnabled = !state.readHookEnabled;
			saveState(pi, state);
			ctx.ui.notify(`Read hook ${state.readHookEnabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
