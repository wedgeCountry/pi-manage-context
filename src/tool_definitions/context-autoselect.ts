/**
 * Pure data for the context-autoselect tool: name/label/description, prompt
 * copy, and the typebox parameter schema. No logic lives here — see
 * src/tools/auto-select.ts / src/tools/context-autoselect.ts.
 */

import { Type, type Static } from "typebox";

export const CONTEXT_AUTOSELECT_PARAMETERS = Type.Object({
	focus: Type.Optional(
		Type.String({
			description: "What the current task is about, so the subagent can judge which turn units are relevant.",
		}),
	),
	dryRun: Type.Optional(
		Type.Boolean({
			description: "Report the groupIds the subagent would unselect without persisting anything. Defaults to false.",
		}),
	),
});

export type ContextAutoselectParams = Static<typeof CONTEXT_AUTOSELECT_PARAMETERS>;

const DESCRIPTION =
	"Review all turn units in your own conversation context with a subagent and unselect the ones that are irrelevant or outdated for the current task. ";

export const CONTEXT_AUTOSELECT_TOOL_DEFINITION = {
	name: "context-autoselect",
	label: "Autoselect relevant context",
	description: DESCRIPTION,
	parameters: CONTEXT_AUTOSELECT_PARAMETERS,
	// Sequential: runs a multi-second subagent that does load-modify-save on
	// shared state — a much wider race window than the other mark tools.
	executionMode: "sequential" as const,
};
