/**
 * Slash commands: /manage_context, /export_context, /toggle-read-hook.
 * Extracted from index.ts so the entry point only registers them; each
 * handler owns its argument parsing and notifications.
 */

import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";

import { exportUnitsToMarkdown } from "./markdown-export.ts";
import { loadState, saveState } from "./state.ts";
import { buildTurnUnits } from "./turn-units.ts";
import { ManageContextView } from "./view.ts";
import { PickerViewModel } from "./picker/picker-view-model.ts";
import { createCompressionService } from "./services/compression-service.ts";
import { createStateService } from "./services/state-service.ts";

export function registerCommands(pi: ExtensionAPI, cachedModels: () => Model<Api>[]): void {
	pi.registerCommand("manage_context", {
		description: "Review, select, compress, or delete messages from the model's context",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const models = cachedModels();
			if (models.length === 0) return null;
			const items = models.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` }));
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
				ctx.ui.notify(`Compression model set to ${trimmed}`, "info");
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
				(tui, theme, _kb: KeybindingsManager, done) => {
					const vm = new PickerViewModel({
						units,
						state,
						stateService: createStateService(pi, ctx),
						compressionService: createCompressionService(ctx, state),
						onClose: done,
					});
					return new ManageContextView(tui, theme, vm, done);
				},
				// pi-tui defaults an overlay's width to min(80, availWidth) when no
				// width is given, which clips this picker to 80 columns on wide
				// terminals. Claim most of the terminal instead.
				{ overlay: true, overlayOptions: { width: "95%", minWidth: 60 } },
			);
		},
	});

	pi.registerCommand("export_context", {
		description: "Export the current context as a markdown file to the working directory",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			if (trimmed.includes("/") || trimmed.includes("\\")) {
				ctx.ui.notify("export_context: filename must be a plain name in the current directory", "error");
				return;
			}
			const filename = trimmed || `context-export-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
			const targetPath = resolve(ctx.cwd, filename);

			const state = loadState(ctx);
			const entries = ctx.sessionManager.buildContextEntries();
			// Deleted units are gone from the model's context by design — the
			// export mirrors what the model actually sees, so they stay excluded.
			const units = buildTurnUnits(entries).filter((u) => state.marks[u.groupId]?.mark !== "deleted");
			if (units.length === 0) {
				ctx.ui.notify("No messages in context yet.", "info");
				return;
			}

			// Summaries are already capped per unit (preserveLineBreaks in
			// turn-units.ts), so the export is a compact, summarized view —
			// not a dump of the full conversation.
			const markdown = exportUnitsToMarkdown(units, {
				title: "Context Export",
				includeSummary: true,
			});

			try {
				await writeFile(targetPath, markdown, "utf-8");
			} catch (error) {
				ctx.ui.notify(`export_context: failed to write ${targetPath}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			ctx.ui.notify(`Exported ${units.length} entries to ${targetPath}`, "info");
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
