/**
 * context-select — the agent-facing counterpart to the picker's Space key:
 * mark turn units selected (visible to the model again) by groupId.
 *
 * Thin adapter over the pure runContextMark() in context-mark.ts: it owns all
 * framework plumbing (session entries, state load/save, UI notification) and
 * delegates the matching/mutation to the plain function. Marks written here
 * are picked up by the existing "context" handler in src/hooks.ts on the very
 * next model call — no separate apply step.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { CONTEXT_SELECT_TOOL_DEFINITION, type ContextSelectParams } from "../tool_definitions/context-select.ts";
import { loadState, saveState } from "../state.ts";
import { buildTurnUnits } from "../turn-units.ts";
import { describeMark } from "../mark-status.ts";
import { runContextMark } from "./context-mark.ts";

function buildContextSelectToolImpl(
	pi: ExtensionAPI,
	definition: typeof CONTEXT_SELECT_TOOL_DEFINITION,
): ToolDefinition<typeof CONTEXT_SELECT_TOOL_DEFINITION.parameters, unknown> {
	return {
		...definition,
		async execute(_toolCallId, params: ContextSelectParams, _signal, _onUpdate, ctx: ExtensionContext) {
			const entries = ctx.sessionManager.buildContextEntries();
			const state = loadState(ctx);
			const units = buildTurnUnits(entries).filter((u) => describeMark(u, state).effective !== "deleted");

			const result = runContextMark(units, state, params.groupIds, "select", definition.name);
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

export function buildContextSelectTool(pi: ExtensionAPI): ToolDefinition<typeof CONTEXT_SELECT_TOOL_DEFINITION.parameters, unknown> {
	return buildContextSelectToolImpl(pi, CONTEXT_SELECT_TOOL_DEFINITION);
}

export function registerContextSelectTool(pi: ExtensionAPI): void {
	pi.registerTool(buildContextSelectTool(pi));
}
