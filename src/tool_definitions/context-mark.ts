/**
 * Shared factory for the context-select / context-unselect tool definitions.
 * Both tools take the same groupIds parameter and differ only in name and
 * copy — everything else, including the sequential execution mode, is
 * identical by construction. Pure data; the logic lives in
 * src/tools/context-mark.ts.
 */

import { Type } from "typebox";

export type MarkAction = "select" | "unselect";

const LABELS: Record<MarkAction, string> = {
	select: "Select context units",
	unselect: "Unselect context units",
};

const DESCRIPTIONS: Record<MarkAction, string> = {
	select:
		"Mark the given turn units of your own conversation context as selected (visible to you again). " +
		"groupIds are the ids shown by the /manage_context picker, view_context, or context-autoselect. " +
		"An empty groupIds array does nothing. Unselected units are hidden from your context on the next turn but are not deleted — this tool brings them back.",
	unselect:
		"Mark the given turn units of your own conversation context as unselected. " +
		"Unselected units are hidden from your context on the next turn — they are not deleted and can be re-selected with context-select. " +
		"groupIds are the ids shown by the /manage_context picker, view_context, or context-autoselect. " +
		"An empty groupIds array does nothing.",
};

const PROMPT_SNIPPETS: Record<MarkAction, string> = {
	select: "context-select — re-select hidden context turns by groupId",
	unselect: "context-unselect — hide context turns by groupId",
};

export function makeMarkToolDefinition(action: MarkAction) {
	const target = action === "select" ? "selected" : "unselected";
	return {
		name: `context-${action}`,
		label: LABELS[action],
		description: DESCRIPTIONS[action],
		promptSnippet: PROMPT_SNIPPETS[action],
		parameters: Type.Object({
			groupIds: Type.Array(Type.String(), {
				description:
					`Exact groupId(s) of the turn units to mark ${target}, as shown by the /manage_context picker, view_context, or reported by context-autoselect. ` +
					"An empty array is a no-op: nothing is changed.",
			}),
		}),
		// Sequential: these tools do load-modify-save on shared state, so two of
		// them in the same assistant turn must not run concurrently (last
		// saveState would clobber the other's marks).
		executionMode: "sequential" as const,
	};
}
