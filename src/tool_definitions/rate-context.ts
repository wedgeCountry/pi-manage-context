/**
 * Pure data for the rate-context tool, written out explicitly: name/label/
 * description, prompt copy, and the typebox parameter schema. This definition
 * is the ONLY tool given to the context-autoselect subagent (see
 * src/tools/context-autoselect-engine.ts). No logic lives here — see
 * src/tools/rate-context.ts.
 */

import { Type, type Static } from "typebox";

export const RATE_CONTEXT_PARAMETERS = Type.Object({
	ratings: Type.Array(
		Type.Object({
			id: Type.String({
				description: "ID (groupId) of the context entry this tuple rates.",
			}),
			score: Type.Number({
				description:
					"Importance of the context snippet for future sessions, between 1 (small importance) and 10 (very high importance). " +
					"Measured by usefulness and relevance; outdated information has low relevance.",
				minimum: 1,
				maximum: 10,
			}),
			reason: Type.String({
				description: "Short reason for the score.",
			}),
		}),
		{
			description: "One tuple per context entry: [ID, score, reason].",
		},
	),
	threshold: Type.Optional(
		Type.Number({
			description:
				"Entries whose score is below this threshold are unselected (hidden from context). Defaults to 5.",
			default: 5,
			minimum: 0,
			maximum: 10,
		}),
	),
});

export type RateContextParams = Static<typeof RATE_CONTEXT_PARAMETERS>;

export const RATE_CONTEXT_TOOL_DEFINITION = {
	name: "rate-context",
	label: "Rate context entries",
	description:
		"Rate each context entry with a tuple of (ID, score 1-10, short reason), where the score measures the importance of the snippet for future sessions. " +
		"Writes an export file of the ratings to the working directory, then unselects every entry whose score is below the given threshold.",
	parameters: RATE_CONTEXT_PARAMETERS,
	// Sequential: this tool does load-modify-save on shared state, so two of
	// them in the same assistant turn must not run concurrently (last
	// saveState would clobber the other's marks).
	executionMode: "sequential" as const,
};
