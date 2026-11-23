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
import { buildTurnUnitGroups, visibleTurnUnits } from "./turn-units.ts";
import { computeWindowExcluded, isWindowActive, loadSettingsWindowConfig, parseWindowConfigArgs, resolveWindowConfig } from "./window-filter.ts";
import { WindowConfigView } from "./config-view.ts";
import { runAutoSelect } from "./tools/context-autoselect-engine.ts";
import { ManageContextView } from "./view.ts";
import { PickerViewModel } from "./picker/picker-view-model.ts";
import { createCompressionService } from "./services/compression-service.ts";
import { createStateService } from "./services/state-service.ts";

/**
 * Parse the optional `auto` argument of /manage_context: "auto" or
 * "auto <focus text>" runs the context-autoselect subagent right away.
 * Returns null when the args are not an auto invocation.
 */
export function parseAutoArgs(args: string): { focus?: string } | null {
	const trimmed = args.trim();
	if (trimmed !== "auto" && !trimmed.startsWith("auto ")) return null;
	const focus = trimmed.slice("auto".length).trim();
	return focus ? { focus } : {};
}

/** Run context-autoselect from the /manage_context auto command and report the outcome. */
async function runAutoSelectCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, focus: string | undefined): Promise<void> {
	const entries = ctx.sessionManager.buildContextEntries();
	const state = loadState(ctx);
	const units = visibleTurnUnits(entries, state);
	if (units.length === 0) {
		ctx.ui.notify("No messages in context yet.", "info");
		return;
	}

	ctx.ui.notify("Running context-autoselect subagent…", "info");
	try {
		const result = await runAutoSelect(pi, ctx, units, state, { focus }, ctx.signal);
		ctx.ui.notify(result.content[0].text.split("\n")[0], "info");
	} catch (error) {
		ctx.ui.notify(`context-autoselect failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

/**
 * Handle the `/mc config` subcommand: bare `config` opens the interactive
 * dialogue (needs a UI); `config off` / `config <tool|assistant|user> <N>`
 * set the window directly and persist it as the session's windowConfig
 * override (which takes precedence over the agent-dir settings.json).
 */
async function runConfigCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const state = loadState(ctx);
	if (args === "") {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"mc config needs an interactive terminal — use '/mc config <tool|assistant|user> <N>' or '/mc config off'",
				"warning",
			);
			return;
		}
		const current = resolveWindowConfig(state, loadSettingsWindowConfig());
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) =>
				new WindowConfigView(
					tui,
					theme,
					current,
					(config) => {
						state.windowConfig = config;
						saveState(pi, state);
						done();
					},
					() => done(),
				),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
		);
		const active = resolveWindowConfig(state, loadSettingsWindowConfig());
		ctx.ui.notify(
			isWindowActive(active) ? `Context window: ${active.mode} ≤ ${active.window}` : "Context window filtering off",
			"info",
		);
		return;
	}
	const parsed = parseWindowConfigArgs(args);
	if (!parsed.ok) {
		ctx.ui.notify(`mc config: ${parsed.error}`, "error");
		return;
	}
	state.windowConfig = parsed.config;
	saveState(pi, state);
	ctx.ui.notify(
		parsed.config.mode === null
			? "Context window filtering off"
			: `Context window: ${parsed.config.mode} ≤ ${parsed.config.window}`,
		"info",
	);
}

type SlashCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

export function registerCommands(pi: ExtensionAPI, cachedModels: () => Model<Api>[]): void {
	// /mc is an alias: same definition object registered under a second name.
	const manageContextCommand: SlashCommand = {
		description: "Review, select, compress, or delete messages from the model's context; 'auto [focus]' runs the context-autoselect subagent right away, 'config' sets the context-window limit (alias: /mc)",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const items: AutocompleteItem[] = [];
			if ("auto".startsWith(prefix)) {
				items.push({ value: "auto", label: "auto — run the context-autoselect subagent now, optionally with a focus description" });
			}
			if ("config".startsWith(prefix)) {
				items.push({ value: "config", label: "config — context window limit: bare opens a dialogue, 'config off' disables, 'config <tool|assistant|user> <N>' sets it" });
			}
			if (prefix.startsWith("config ")) {
				const sub = prefix.slice("config ".length);
				for (const m of ["off", "tool", "assistant", "user"]) {
					if (m.startsWith(sub)) {
						items.push({
							value: `config ${m}`,
							label:
								m === "off"
									? "config off — disable window filtering"
									: `config ${m} <N> — keep the latest N ${m === "tool" ? "tool calls" : m === "assistant" ? "assistant messages and tool calls" : "user, assistant and tool messages"}`,
						});
					}
				}
			}
			const models = cachedModels();
			items.push(...models.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` })));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const state = loadState(ctx);
			const trimmed = args.trim();

			const auto = parseAutoArgs(trimmed);
			if (auto) {
				await runAutoSelectCommand(pi, ctx, auto.focus);
				return;
			}

			if (trimmed === "config" || trimmed.startsWith("config ")) {
				await runConfigCommand(pi, ctx, trimmed.slice("config".length).trim());
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("manage_context requires an interactive terminal", "warning");
				return;
			}

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
			const units = visibleTurnUnits(entries, state);
			if (units.length === 0) {
				ctx.ui.notify("No messages in context yet.", "info");
				return;
			}

			// Window-limit info for the picker header/grey-out: computed over
			// ALL structural groups (marks ignored for counting), not just the
			// visible units.
			const windowConfig = resolveWindowConfig(state, loadSettingsWindowConfig());
			const windowExcluded = computeWindowExcluded(buildTurnUnitGroups(entries), windowConfig);

			await ctx.ui.custom<void>(
				(tui, theme, _kb: KeybindingsManager, done) => {
					const vm = new PickerViewModel({
						units,
						state,
						stateService: createStateService(pi, ctx),
						compressionService: createCompressionService(ctx, state),
						onClose: done,
						windowConfig,
						windowExcluded,
					});
					return new ManageContextView(tui, theme, vm, done);
				},
				// pi-tui defaults an overlay's width to min(80, availWidth), which
				// clips this picker to 80 columns on wide terminals. The picker
				// renders one line per terminal row, so capping height at 100%
				// makes it fill the whole terminal.
				{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
			);
		},
	};
	pi.registerCommand("manage_context", manageContextCommand);
	pi.registerCommand("mc", manageContextCommand);

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
			const units = visibleTurnUnits(entries, state);
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
