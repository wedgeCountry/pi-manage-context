/**
 * context-autoselect — delegate relevance judgment to an in-process subagent
 * that unselects irrelevant/outdated turn units by groupId.
 *
 * Thin adapter over runAutoSelect() in auto-select.ts: it owns all framework
 * plumbing (session entries, state load, UI notification) and delegates the
 * subagent run to the engine. The subagent's only tool is context-unselect,
 * so this can hide units but never select, compress, or delete them.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { CONTEXT_AUTOSELECT_TOOL_DEFINITION } from "../tool_definitions/context-autoselect.ts";
import { loadState } from "../state.ts";
import { buildTurnUnits } from "../turn-units.ts";
import { describeMark } from "../mark-status.ts";
import { createTool } from "./createTool.ts";
import { runAutoSelect, type AutoSelectResult } from "./context-autoselect-engine.ts";

function buildContextAutoselectToolImpl(
	pi: ExtensionAPI,
	definition: typeof CONTEXT_AUTOSELECT_TOOL_DEFINITION,
): ToolDefinition<typeof CONTEXT_AUTOSELECT_TOOL_DEFINITION.parameters, AutoSelectResult["details"]> {
	return createTool(definition, {
		execute: async (params, { signal, ctx }) => {
			const entries = ctx.sessionManager.buildContextEntries();
			const state = loadState(ctx);
			const units = buildTurnUnits(entries).filter((u) => describeMark(u, state).effective !== "deleted");

			const result = await runAutoSelect(pi, ctx, units, state, params, signal);
			if (result.details.unselected.length > 0 && !result.details.dryRun) {
				ctx.ui.notify(`${definition.name}: ${result.content[0].text.split("\n")[0]}`, "info");
			}

			return { content: result.content, details: result.details };
		},
	});
}

export function buildContextAutoselectTool(pi: ExtensionAPI): ToolDefinition<typeof CONTEXT_AUTOSELECT_TOOL_DEFINITION.parameters, AutoSelectResult["details"]> {
	return buildContextAutoselectToolImpl(pi, CONTEXT_AUTOSELECT_TOOL_DEFINITION);
}

export function registerContextAutoselectTool(pi: ExtensionAPI): void {
	pi.registerTool(buildContextAutoselectTool(pi));
}
