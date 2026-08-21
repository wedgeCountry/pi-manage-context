/**
 * manage_context_select — the agent-facing counterpart to the interactive
 * picker in view.ts. Lets the model itself list turn units and flip their
 * selected/unselected mark by a text match or groupId, without a human at
 * the keyboard.
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

import { Type, type Static } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { loadState, saveState } from "./state.ts";
import { buildTurnUnits, type TurnUnit } from "./turn-units.ts";
import { toLLMMemoryEntry } from "./llm-export.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const paramsSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("select"), Type.Literal("unselect")], {
		description:
			'"list" reports every turn unit currently in context with its groupId, heading, type, token count, and mark. ' +
			'"select"/"unselect" apply that mark to units matching textMatch and/or groupIds (at least one of those two must be given for select/unselect).',
	}),
	textMatch: Type.Optional(
		Type.String({
			description:
				"Case-insensitive substring searched across each unit's heading, full message text, and — for tool-call units, whose heading is always just \"Tool interactions\" — every tool call's name, arguments, and result too. " +
				'Use this to catch tool calls related to a topic (e.g. "poem" also matches a write_file call whose arguments or result mention a poem), not just user/assistant text.',
		}),
	),
	groupIds: Type.Optional(
		Type.Array(Type.String(), {
			description: "Exact groupId(s) to affect, as reported by a prior 'list' call. Combine freely with textMatch — a unit matches if either matches.",
		}),
	),
});

type Params = Static<typeof paramsSchema>;

/** Everything worth substring-matching against, lowercased and flattened to one string. */
function unitSearchText(unit: TurnUnit): string {
	const parts = [unit.metadata.heading, unit.metadata.summary];
	for (const call of unit.metadata.toolCalls ?? []) {
		parts.push(call.name, JSON.stringify(call.arguments), call.result ?? "", call.description ?? "");
	}
	return parts.join("\n").toLowerCase();
}

function matches(unit: TurnUnit, textMatch: string | undefined, groupIds: string[] | undefined): boolean {
	const byText = textMatch !== undefined && unitSearchText(unit).includes(textMatch.toLowerCase());
	const byId = groupIds !== undefined && groupIds.includes(unit.groupId);
	if (textMatch === undefined && groupIds === undefined) return false;
	return byText || byId;
}

export function buildManageContextSelectTool(pi: ExtensionAPI): ToolDefinition<typeof paramsSchema, unknown> {
	return {
		name: "manage_context_select",
		label: "Manage context (select)",
		description:
			"List the turn units in your own conversation context, or select/unselect them by a text substring (matched against heading, message text, and tool call name/arguments/result) or groupId. " +
			"Unselected units are hidden from your context on the next turn — they are not deleted and can be re-selected later. " +
			"Use 'list' first to see current groupIds, headings, and marks before selecting/unselecting.",
		promptSnippet: "manage_context_select — list/select/unselect your own context turns by topic",
		parameters: paramsSchema,
		async execute(_toolCallId, params: Params, _signal, _onUpdate, ctx: ExtensionContext) {
			const entries = ctx.sessionManager.buildContextEntries();
			const state = loadState(ctx);
			const units = buildTurnUnits(entries).filter((u) => state.marks[u.groupId]?.mark !== "deleted");

			if (params.action === "list") {
				const rows = units.map((u) => ({
					...toLLMMemoryEntry(u),
					mark: state.marks[u.groupId]?.mark ?? "selected",
				}));
				return {
					content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
					details: rows,
				};
			}

			if (params.textMatch === undefined && params.groupIds === undefined) {
				return {
					content: [
						{
							type: "text",
							text: "manage_context_select: provide textMatch and/or groupIds to select/unselect units.",
						},
					],
					details: undefined,
				};
			}

			const targetMark = params.action === "select" ? "selected" : "unselected";
			const affected: string[] = [];
			for (const unit of units) {
				if (!matches(unit, params.textMatch, params.groupIds)) continue;
				const existing = state.marks[unit.groupId];
				state.marks[unit.groupId] = { ...existing, mark: targetMark };
				affected.push(unit.groupId);
			}

			if (affected.length > 0) saveState(pi, state);

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
			};
		},
	};
}
