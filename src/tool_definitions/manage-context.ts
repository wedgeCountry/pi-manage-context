/**
 * Pure data for the manage-context tool: name/label/description, prompt copy,
 * and the typebox parameter schema. No logic lives here — see
 * src/tools/manage-context.ts for the plain function and registerXTool(pi).
 *
 * Registered under two names sharing one implementation: "manage-context" is
 * the current name, "manage_context_select" is a legacy underscore alias kept
 * for backward compatibility with sessions/prompts that already reference it.
 */

import { Type, type Static } from "typebox";

export const MANAGE_CONTEXT_PARAMETERS = Type.Object({
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

export type ManageContextParams = Static<typeof MANAGE_CONTEXT_PARAMETERS>;

const DESCRIPTION =
	"list/select/unselect the turn units in your own conversation context. 'list' reports every unit; 'select'/'unselect' apply that mark to units matched by a text substring (matched against heading, message text, and tool call name/arguments/result) or groupId. " +
	"Unselected units are hidden from your context on the next turn — they are not deleted and can be re-selected later. " +
	"Use 'list' first to see current groupIds, headings, and marks before selecting/unselecting.";

export const MANAGE_CONTEXT_TOOL_DEFINITION = {
	name: "manage-context",
	label: "Manage context",
	description: DESCRIPTION,
	promptSnippet: "manage-context — list/select/unselect your own context turns by topic",
	parameters: MANAGE_CONTEXT_PARAMETERS,
};

/** Hyphenated-name definition's underscore predecessor, kept for compatibility. */
export const MANAGE_CONTEXT_SELECT_TOOL_DEFINITION = {
	...MANAGE_CONTEXT_TOOL_DEFINITION,
	name: "manage_context_select",
	label: "Manage context (select)",
	promptSnippet: "manage_context_select — list/select/unselect your own context turns by topic",
};
