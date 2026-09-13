/**
 * manage-context / manage_context_select — the agent-facing counterpart to
 * the interactive picker in view.ts. Lets the model itself list turn units
 * and flip their selected/unselected mark by a text match or groupId,
 * without a human at the keyboard.
 *
 * A tool-call unit's heading is always the generic "Tool interactions"
 * (see generateHeading() in turn-units.ts) — it never describes what the
 * call actually did. So textMatch searches each unit's full text (heading +
 * message summary + tool call names/arguments/results), not the heading
 * alone, or a topical match like "poem" would silently skip every tool call
 * that produced or consumed poem content while still catching the
 * surrounding user/assistant turns.
 *
 * Deliberately scoped to select/unselected only: compress costs an extra LLM
 * call and delete is irreversible, so both stay picker-only (human
 * confirmation via Esc) for now. Marks written here are picked up by the
 * existing "context" handler in index.ts on the very next model call — no
 * separate apply step.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
	MANAGE_CONTEXT_SELECT_TOOL_DEFINITION,
	MANAGE_CONTEXT_TOOL_DEFINITION,
	type ManageContextParams,
} from "../tool_definitions/manage-context.ts";
import { loadState, saveState, type ManageContextState } from "../state.ts";
import { buildTurnUnits, type TurnUnit } from "../turn-units.ts";
import { toLLMMemoryEntry } from "../llm-export.ts";

export interface ManageContextRunResult {
	content: [{ type: "text"; text: string }];
	details: unknown;
	/** Whether state.marks was mutated and needs to be persisted via saveState(). */
	changed: boolean;
}

/** Everything worth substring-matching against, lowercased and flattened to one string. */
export function unitSearchText(unit: TurnUnit): string {
	const parts = [unit.metadata.heading, unit.metadata.summary];
	for (const call of unit.metadata.toolCalls ?? []) {
		parts.push(call.name, JSON.stringify(call.arguments), call.result ?? "", call.description ?? "");
	}
	return parts.join("\n").toLowerCase();
}

export function unitMatches(unit: TurnUnit, textMatch: string | undefined, groupIds: string[] | undefined): boolean {
	const byText = textMatch !== undefined && unitSearchText(unit).includes(textMatch.toLowerCase());
	const byId = groupIds !== undefined && groupIds.includes(unit.groupId);
	if (textMatch === undefined && groupIds === undefined) return false;
	return byText || byId;
}

/**
 * Plain function: no ExtensionAPI/ExtensionContext involved. Takes the turn
 * units and persisted state the caller already fetched, mutates state.marks
 * in place for select/unselect, and returns the tool result plus whether the
 * caller needs to persist the (mutated) state.
 *
 * `toolName` is only used to word the "provide textMatch and/or groupIds"
 * guidance message, so both registered names produce an on-brand hint.
 */
export function runManageContext(units: TurnUnit[], state: ManageContextState, params: ManageContextParams, toolName: string): ManageContextRunResult {
	if (params.action === "list") {
		const rows = units.map((u) => ({
			...toLLMMemoryEntry(u),
			mark: state.marks[u.groupId]?.mark ?? "selected",
		}));
		return {
			content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
			details: rows,
			changed: false,
		};
	}

	if (params.textMatch === undefined && params.groupIds === undefined) {
		return {
			content: [{ type: "text", text: `${toolName}: provide textMatch and/or groupIds to select/unselect units.` }],
			details: undefined,
			changed: false,
		};
	}

	const targetMark = params.action === "select" ? "selected" : "unselected";
	const affected: string[] = [];
	for (const unit of units) {
		if (!unitMatches(unit, params.textMatch, params.groupIds)) continue;
		const existing = state.marks[unit.groupId];
		state.marks[unit.groupId] = { ...existing, mark: targetMark };
		affected.push(unit.groupId);
	}

	return {
		content: [
			{
				type: "text",
				text:
					affected.length === 0
						? "No turn units matched — nothing changed."
						: `Marked ${affected.length} unit(s) as ${targetMark}: ${affected.join(", ")}`,
			},
		],
		details: affected,
		changed: affected.length > 0,
	};
}

function buildManageContextToolImpl(pi: ExtensionAPI, definition: typeof MANAGE_CONTEXT_TOOL_DEFINITION): ToolDefinition<typeof MANAGE_CONTEXT_TOOL_DEFINITION.parameters, unknown> {
	return {
		...definition,
		async execute(_toolCallId, params: ManageContextParams, _signal, _onUpdate, ctx: ExtensionContext) {
			const entries = ctx.sessionManager.buildContextEntries();
			const state = loadState(ctx);
			const units = buildTurnUnits(entries).filter((u) => state.marks[u.groupId]?.mark !== "deleted");

			const result = runManageContext(units, state, params, definition.name);
			if (result.changed) saveState(pi, state);

			return { content: result.content, details: result.details };
		},
	};
}

/** Original tool name (hyphenated). */
export function buildManageContextTool(pi: ExtensionAPI): ToolDefinition<typeof MANAGE_CONTEXT_TOOL_DEFINITION.parameters, unknown> {
	return buildManageContextToolImpl(pi, MANAGE_CONTEXT_TOOL_DEFINITION);
}

/** Legacy underscore alias, kept for backward compatibility. */
export function buildManageContextSelectTool(pi: ExtensionAPI): ToolDefinition<typeof MANAGE_CONTEXT_TOOL_DEFINITION.parameters, unknown> {
	return buildManageContextToolImpl(pi, MANAGE_CONTEXT_SELECT_TOOL_DEFINITION);
}

export function registerManageContextTool(pi: ExtensionAPI): void {
	pi.registerTool(buildManageContextTool(pi));
}

export function registerManageContextSelectTool(pi: ExtensionAPI): void {
	pi.registerTool(buildManageContextSelectTool(pi));
}
