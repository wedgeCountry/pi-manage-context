/**
 * Shared pure logic behind context-select and context-unselect: match turn
 * units by groupId only and flip their selected/unselected mark.
 *
 * Matching is groupId-only on purpose — the old textMatch path could hit
 * units the caller didn't intend (a broad substring matches every unit whose
 * tool *result* mentions the topic), and the autoselect subagent works
 * exclusively with groupIds. Unknown ids are reported, never silently
 * applied; an empty groupIds array is a no-op.
 *
 * Mutating calls report what they matched BEFORE changing it — id, one-line
 * heading, and the unit's previous effective mark per affected unit — so the
 * caller sees exactly which units changed instead of discovering collateral
 * matches after the fact.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CONTEXT_SELECT_TOOL_DEFINITION } from "../tool_definitions/context-select.ts";
import type { CONTEXT_UNSELECT_TOOL_DEFINITION } from "../tool_definitions/context-unselect.ts";
import { loadState, saveState, type ManageContextState, type Mark } from "../state.ts";
import { buildTurnUnits, oneLine, type TurnUnit } from "../turn-units.ts";
import { describeMark } from "../mark-status.ts";

export interface ContextMarkResult {
	content: [{ type: "text"; text: string }];
	/** groupIds whose mark was written. */
	details: string[];
	/** Whether state.marks was mutated and needs to be persisted via saveState(). */
	changed: boolean;
}

/**
 * Plain function: no ExtensionAPI/ExtensionContext involved. Takes the turn
 * units and persisted state the caller already fetched, mutates state.marks
 * in place, and returns the tool result plus whether the caller needs to
 * persist the (mutated) state.
 */
export function runContextMark(
	units: TurnUnit[],
	state: ManageContextState,
	groupIds: string[],
	action: "select" | "unselect",
	toolName: string,
): ContextMarkResult {
	if (groupIds.length === 0) {
		return {
			content: [{ type: "text", text: `${toolName}: no groupIds given — nothing changed.` }],
			details: [],
			changed: false,
		};
	}

	const targetMark: Mark = action === "select" ? "selected" : "unselected";
	const matched = units.filter((unit) => groupIds.includes(unit.groupId));
	const matchedIds = new Set(matched.map((u) => u.groupId));
	const unknown = groupIds.filter((id) => !matchedIds.has(id));

	// Preview what the match hits before (and while) changing it.
	const previews = matched.map((unit) => ({
		id: unit.groupId,
		heading: oneLine(unit.metadata.heading, 80),
		was: describeMark(unit, state).effective,
	}));

	const affected: string[] = [];
	for (const unit of matched) {
		const existing = state.marks[unit.groupId];
		state.marks[unit.groupId] = { ...existing, mark: targetMark };
		affected.push(unit.groupId);
	}

	const lines: string[] = [];
	if (affected.length === 0) {
		lines.push("No turn units matched — nothing changed.");
	} else {
		lines.push(`Marked ${affected.length} unit(s) as ${targetMark}:`);
		for (const preview of previews) {
			lines.push(`  ${preview.id}  ${preview.heading}  (was: ${preview.was})`);
		}
	}
	if (unknown.length > 0) {
		lines.push(`Not matched (unknown groupIds): ${unknown.join(", ")}`);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: affected,
		changed: affected.length > 0,
	};
}

/**
 * The one shared adapter behind context-select and context-unselect: owns all
 * framework plumbing (session entries, state load/save, UI notification) and
 * delegates matching/mutation to runContextMark(). Marks written here are
 * picked up by the "context" handler in src/hooks.ts on the very next model
 * call — no separate apply step.
 */
export function buildContextMarkTool(
	pi: ExtensionAPI,
	definition: typeof CONTEXT_SELECT_TOOL_DEFINITION | typeof CONTEXT_UNSELECT_TOOL_DEFINITION,
	action: "select" | "unselect",
): ToolDefinition<typeof definition.parameters, unknown> {
	return {
		...definition,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const entries = ctx.sessionManager.buildContextEntries();
			const state = loadState(ctx);
			const units = buildTurnUnits(entries).filter((u) => describeMark(u, state).effective !== "deleted");

			const result = runContextMark(units, state, params.groupIds, action, definition.name);
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
