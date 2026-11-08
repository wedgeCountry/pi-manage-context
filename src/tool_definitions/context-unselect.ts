/**
 * Pure data for the context-unselect tool: name/label/description, prompt
 * copy, and the typebox parameter schema. No logic lives here — see
 * src/tools/context-unselect.ts for the plain function and registerTool(pi).
 */

import { Type, type Static } from "typebox";

export const CONTEXT_UNSELECT_PARAMETERS = Type.Object({
	groupIds: Type.Array(Type.String(), {
		description:
			"Exact groupId(s) of the turn units to mark unselected, as shown by the /manage_context picker, view_context, or reported by context-autoselect. " +
			"An empty array is a no-op: nothing is changed.",
	}),
});

export type ContextUnselectParams = Static<typeof CONTEXT_UNSELECT_PARAMETERS>;

const DESCRIPTION =
	"Mark the given turn units of your own conversation context as unselected. " +
	"Unselected units are hidden from your context on the next turn — they are not deleted and can be re-selected with context-select. " +
	"groupIds are the ids shown by the /manage_context picker, view_context, or context-autoselect. " +
	"An empty groupIds array does nothing.";

export const CONTEXT_UNSELECT_TOOL_DEFINITION = {
	name: "context-unselect",
	label: "Unselect context units",
	description: DESCRIPTION,
	promptSnippet: "context-unselect — hide context turns by groupId",
	parameters: CONTEXT_UNSELECT_PARAMETERS,
};
