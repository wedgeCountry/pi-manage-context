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
			"Exact groupId(s) of the turn units to mark unselected. An empty array is a no-op: nothing is changed.",
	}),
});

export type ContextUnselectParams = Static<typeof CONTEXT_UNSELECT_PARAMETERS>;

export const CONTEXT_UNSELECT_TOOL_DEFINITION = {
	name: "context-unselect",
	label: "Unselect context units",
	description: "Mark the turn units of the givenconversation context as unselected."
	parameters: CONTEXT_UNSELECT_PARAMETERS,
	// Sequential: these tools do load-modify-save on shared state, so two of
	// them in the same assistant turn must not run concurrently (last
	// saveState would clobber the other's marks).
	executionMode: "sequential" as const,
};
