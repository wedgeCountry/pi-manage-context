/**
 * Pure data for the context-select tool, written out explicitly: name/label/
 * description, prompt copy, and the typebox parameter schema. No logic lives
 * here — see src/tools/context-mark.ts.
 */

import { Type, type Static } from "typebox";

export const CONTEXT_SELECT_PARAMETERS = Type.Object({
	groupIds: Type.Array(Type.String(), {
		description:
			"Exact groupId(s) of the turn units to mark selected. An empty array is a no-op: nothing is changed.",
	}),
});

export type ContextSelectParams = Static<typeof CONTEXT_SELECT_PARAMETERS>;

export const CONTEXT_SELECT_TOOL_DEFINITION = {
	name: "context-select",
	label: "Select context units",
	description: "Mark the given turn units of your own conversation context as selected",
	parameters: CONTEXT_SELECT_PARAMETERS,
	// Sequential: these tools do load-modify-save on shared state, so two of
	// them in the same assistant turn must not run concurrently (last
	// saveState would clobber the other's marks).
	executionMode: "sequential" as const,
};
