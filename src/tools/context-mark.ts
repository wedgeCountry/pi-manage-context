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

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { CONTEXT_SELECT_TOOL_DEFINITION } from "../tool_definitions/context-select.ts";
import { CONTEXT_UNSELECT_TOOL_DEFINITION } from "../tool_definitions/context-unselect.ts";
import { loadState, saveState, type ManageContextState, type Mark } from "../state.ts";
import { visibleTurnUnits, oneLine, type TurnUnit } from "../turn-units.ts";
import { describeMark } from "../mark-status.ts";
import { createTool } from "./createTool.ts";

/** Cap for the one-line heading shown in the per-unit preview. */
export const PREVIEW_HEADING_MAX = 80;

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
		heading: oneLine(unit.metadata.heading, PREVIEW_HEADING_MAX),
		was: describeMark(unit, state).effective,
	}));

	const affected: string[] = [];
	for (const unit of matched) {
		// Skip no-op writes: a unit already at the target mark isn't rewritten
		// (which would persist a fresh snapshot and notify for nothing).
		const current = state.marks[unit.groupId]?.mark ?? "selected";
		if (current === targetMark) continue;
		const existing = state.marks[unit.groupId];
		state.marks[unit.groupId] = { ...existing, mark: targetMark };
		affected.push(unit.groupId);
	}

	const lines: string[] = [];
	if (matched.length === 0) {
		lines.push("No turn units matched — nothing changed.");
	} else if (affected.length === 0) {
		lines.push(`All ${matched.length} matched unit(s) were already ${targetMark} — nothing changed.`);
	} else {
		lines.push(`Marked ${affected.length} unit(s) as ${targetMark}:`);
		for (const preview of previews) {
			if (!affected.includes(preview.id)) continue;
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
): ToolDefinition<typeof CONTEXT_SELECT_TOOL_DEFINITION.parameters, string[]> {
	return createTool(definition, {
		execute: async (params, { ctx }) => {
			const entries = ctx.sessionManager.buildContextEntries();
			const state = loadState(ctx);
			const units = visibleTurnUnits(entries, state);

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
	});
}

/** context-select — mark turn units selected (visible to the model again) by groupId. */
export function buildContextSelectTool(pi: ExtensionAPI): ToolDefinition<typeof CONTEXT_SELECT_TOOL_DEFINITION.parameters, string[]> {
	return buildContextMarkTool(pi, CONTEXT_SELECT_TOOL_DEFINITION, "select");
}

/**
 * context-unselect — hide turn units from the model's context by groupId.
 * This is also the ONLY tool given to the context-autoselect subagent, so
 * autoselect can hide units but never select, compress, or delete them.
 */
export function buildContextUnselectTool(pi: ExtensionAPI): ToolDefinition<typeof CONTEXT_UNSELECT_TOOL_DEFINITION.parameters, string[]> {
	return buildContextMarkTool(pi, CONTEXT_UNSELECT_TOOL_DEFINITION, "unselect");
}

/** Register both groupId-marking tools. */
export function registerContextMarkTools(pi: ExtensionAPI): void {
	pi.registerTool(buildContextSelectTool(pi));
	pi.registerTool(buildContextUnselectTool(pi));
}
