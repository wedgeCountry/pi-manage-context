/**
 * Pure data for the context-unselect tool, written out explicitly: name/
 * label/description, prompt copy, and the typebox parameter schema. This
 * definition is also the ONLY tool given to the context-autoselect subagent.
 * No logic lives here — see src/tools/context-mark.ts.
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

export const CONTEXT_UNSELECT_TOOL_DEFINITION = {
	name: "context-unselect",
	label: "Unselect context units",
	description:
		"Mark the given turn units of your own conversation context as unselected. " +
		"Unselected units are hidden from your context on the next turn — they are not deleted and can be re-selected with context-select. " +
		"groupIds are the ids shown by the /manage_context picker, view_context, or context-autoselect. " +
		"An empty groupIds array does nothing.",
	promptSnippet: "context-unselect — hide context turns by groupId",
	parameters: CONTEXT_UNSELECT_PARAMETERS,
	// Sequential: these tools do load-modify-save on shared state, so two of
	// them in the same assistant turn must not run concurrently (last
	// saveState would clobber the other's marks).
	executionMode: "sequential" as const,
};
