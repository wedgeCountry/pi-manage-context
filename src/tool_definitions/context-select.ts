/**
 * Pure data for the context-select tool: name/label/description, prompt copy,
 * and the typebox parameter schema. No logic lives here — see
 * src/tools/context-select.ts for the plain function and registerTool(pi).
 */

import { Type, type Static } from "typebox";

export const CONTEXT_SELECT_PARAMETERS = Type.Object({
	groupIds: Type.Array(Type.String(), {
		description:
			"Exact groupId(s) of the turn units to mark selected, as shown by the /manage_context picker, view_context, or reported by context-autoselect. " +
			"An empty array is a no-op: nothing is changed.",
	}),
});

export type ContextSelectParams = Static<typeof CONTEXT_SELECT_PARAMETERS>;

const DESCRIPTION =
	"Mark the given turn units of your own conversation context as selected (visible to you again). " +
	"groupIds are the ids shown by the /manage_context picker, view_context, or context-autoselect. " +
	"An empty groupIds array does nothing. Unselected units are hidden from your context on the next turn but are not deleted — this tool brings them back.";

export const CONTEXT_SELECT_TOOL_DEFINITION = {
	name: "context-select",
	label: "Select context units",
	description: DESCRIPTION,
	promptSnippet: "context-select — re-select hidden context turns by groupId",
	parameters: CONTEXT_SELECT_PARAMETERS,
	// Sequential: these tools do load-modify-save on shared state, so two of
	// them in the same assistant turn must not run concurrently (last
	// saveState would clobber the other's marks).
	executionMode: "sequential" as const,
};
