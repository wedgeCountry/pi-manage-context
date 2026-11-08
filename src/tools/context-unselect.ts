/**
 * context-unselect — hide turn units from the model's context by groupId.
 *
 * Thin adapter over the pure runContextMark() in context-mark.ts: it owns all
 * framework plumbing (session entries, state load/save, UI notification) and
 * delegates the matching/mutation to the plain function. Marks written here
 * are picked up by the existing "context" handler in src/hooks.ts on the very
 * next model call — no separate apply step. This tool is also the ONLY tool
 * given to the context-autoselect subagent, so autoselect can hide units but
 * never select, compress, or delete them.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { CONTEXT_UNSELECT_TOOL_DEFINITION, type ContextUnselectParams } from "../tool_definitions/context-unselect.ts";
import { loadState, saveState } from "../state.ts";
import { buildTurnUnits } from "../turn-units.ts";
import { describeMark } from "../mark-status.ts";
import { runContextMark } from "./context-mark.ts";

function buildContextUnselectToolImpl(
	pi: ExtensionAPI,
	definition: typeof CONTEXT_UNSELECT_TOOL_DEFINITION,
): ToolDefinition<typeof CONTEXT_UNSELECT_TOOL_DEFINITION.parameters, unknown> {
	return {
		...definition,
		async execute(_toolCallId, params: ContextUnselectParams, _signal, _onUpdate, ctx: ExtensionContext) {
			const entries = ctx.sessionManager.buildContextEntries();
			const state = loadState(ctx);
			const units = buildTurnUnits(entries).filter((u) => describeMark(u, state).effective !== "deleted");

			const result = runContextMark(units, state, params.groupIds, "unselect", definition.name);
			if (result.changed) {
				saveState(pi, state);
				// select/unselect silently change what the model sees on its very
				// next turn (see the "context" handler in src/hooks.ts) — surface it
				// so a human watching the session has a visible trail of the agent
				// editing its own context, instead of content just disappearing.
				ctx.ui.notify(`${definition.name}: ${result.content[0].text.split("\n")[0]}`, "info");
			}

			return { content: result.content, details: result.details };
		},
	};
}

export function buildContextUnselectTool(pi: ExtensionAPI): ToolDefinition<typeof CONTEXT_UNSELECT_TOOL_DEFINITION.parameters, unknown> {
	return buildContextUnselectToolImpl(pi, CONTEXT_UNSELECT_TOOL_DEFINITION);
}

export function registerContextUnselectTool(pi: ExtensionAPI): void {
	pi.registerTool(buildContextUnselectTool(pi));
}
