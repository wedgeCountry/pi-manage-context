/**
 * Session event hooks: the "context" filter and the two "tool_result"
 * auto-unselect hooks. Extracted from index.ts so the entry point is pure
 * wiring (register handlers/tools/commands) and the hook logic is importable
 * and testable on its own.
 *
 * The manage-context tool's own tool call + result are auto-unselected right
 * after it runs (see the "tool_result" hook below) — otherwise every
 * subsequent turn would keep re-sending the tool call that was supposed to
 * shrink the context, defeating the point. Both registered names count (the
 * tool is registered under two names sharing one implementation).
 */

import { resolve } from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isReadToolResult } from "@earendil-works/pi-coding-agent";

import { buildFilteredMessages } from "./context-filter.ts";
import { loadState, saveState, hasMarks, pruneMarks } from "./state.ts";
import { buildTurnUnitGroups, buildTurnUnits, type TurnUnit } from "./turn-units.ts";

export const SELF_UNSELECT_TOOL_NAMES = new Set(["manage-context", "manage_context_select"]);

/**
 * True if `unit`'s anchor assistant message has exactly one tool call and
 * its id is `toolCallId`. Hiding a unit hides every call bundled into it, so
 * this deliberately refuses to match when the matching call shares its turn
 * with any other tool call (same collateral-damage guard as
 * unitHasMatchingRead below) — callers that auto-hide on a match would
 * otherwise also hide unrelated calls' results just because they happened
 * to land in the same assistant turn.
 */
export function unitHasMatchingToolCallId(unit: TurnUnit, toolCallId: string): boolean {
	if (unit.kind !== "assistant_tool") return false;
	if (unit.anchorEntry.type !== "message" || unit.anchorEntry.message.role !== "assistant") return false;

	const toolCalls = unit.anchorEntry.message.content.filter((block) => block.type === "toolCall");
	if (toolCalls.length !== 1) return false;

	return toolCalls[0].id === toolCallId;
}

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

/** The "context" event: apply marks to the outgoing messages, skipping all work when nothing is marked. */
export function handleContext(_event: ContextEvent, ctx: ExtensionContext) {
	const state = loadState(ctx);
	if (!hasMarks(state)) return; // nothing to change — skip all grouping work
	const entries = ctx.sessionManager.buildContextEntries();
	// Cheap structural groups only: the filter needs entryIds/kind, not
	// the enriched metadata the picker and tools use.
	const groups = buildTurnUnitGroups(entries);
	return { messages: buildFilteredMessages(entries, groups, state) };
}

/** tool_result hook: with the read hook enabled, unselect read() calls whose result matches a marked unit. */
export function handleReadToolResult(event: ToolResultEvent, ctx: ExtensionContext, pi: ExtensionAPI): void {
	if (!isReadToolResult(event)) return;
	if (event.isError) return;

	const state = loadState(ctx);
	if (!state.readHookEnabled) return;
	if (!hasMarks(state)) return; // nothing marked — no read can match anything

	const path = event.input.path;
	if (typeof path !== "string") return;
	const resolvedPath = resolve(path);

	const units = buildTurnUnits(ctx.sessionManager.buildContextEntries());
	let changed = false;
	for (const unit of units) {
		if (!unitHasMatchingRead(unit, resolvedPath, event.toolCallId)) continue;

		// Deletions are permanent by design (see the picker docs in index.ts) —
		// never resurrect one into the lesser "unselected" state.
		const mark = state.marks[unit.groupId]?.mark;
		if (mark === "deleted" || mark === "unselected") continue;

		state.marks[unit.groupId] = { mark: "unselected" };
		changed = true;
	}

	if (changed) {
		pruneMarks(state, new Set(units.map((u) => u.groupId)));
		saveState(pi, state);
	}
}

/** tool_result hook: auto-unselect manage-context's own tool call (keeping only the latest one hidden). */
export function handleSelfUnselectToolResult(event: ToolResultEvent, ctx: ExtensionContext, pi: ExtensionAPI): void {
	if (!SELF_UNSELECT_TOOL_NAMES.has(event.toolName)) return;
	if (event.isError) return;

	const units = buildTurnUnits(ctx.sessionManager.buildContextEntries());
	const unit = units.find((u) => unitHasMatchingToolCallId(u, event.toolCallId));
	if (!unit) return;

	const state = loadState(ctx);
	let changed = false;

	// Only the most recently completed manage-context call stays
	// auto-hidden. Without this, a session that calls the tool several
	// times (e.g. one prompt triggering multiple unselect calls) would
	// have every one of them vanish from context — restore any earlier
	// call this same hook had hidden, unless the user has since taken it
	// over with their own mark (deletion, or a compression).
	for (const other of units) {
		if (other.groupId === unit.groupId) continue;
		if (other.kind !== "assistant_tool") continue;
		if (!other.metadata.toolCalls?.some((tc) => SELF_UNSELECT_TOOL_NAMES.has(tc.name))) continue;
		if (state.marks[other.groupId]?.mark === "unselected") {
			delete state.marks[other.groupId];
			changed = true;
		}
	}

	// Deletions are permanent by design (see the picker docs in index.ts) — never
	// resurrect one into the lesser "unselected" state.
	const mark = state.marks[unit.groupId]?.mark;
	if (mark !== "deleted") {
		state.marks[unit.groupId] = { mark: "unselected" };
		changed = true;
	}

	if (changed) {
		pruneMarks(state, new Set(units.map((u) => u.groupId)));
		saveState(pi, state);
	}
}

/** Register all session event hooks on the extension API. */
export function registerHooks(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => handleContext(event, ctx));
	pi.on("tool_result", (event, ctx) => handleReadToolResult(event, ctx, pi));
	pi.on("tool_result", (event, ctx) => handleSelfUnselectToolResult(event, ctx, pi));
}
