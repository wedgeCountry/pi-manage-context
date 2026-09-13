/**
 * Pure data for the view_context tool: name/label/description, prompt copy,
 * and the typebox parameter schema. No logic lives here — see
 * src/tools/view-context.ts for the plain functions and registerViewContextTool(pi).
 */

import { Type, type Static } from "typebox";

export const VIEW_CONTEXT_PARAMETERS = Type.Object({
	format: Type.Optional(
		Type.Union([Type.Literal("summary"), Type.Literal("detailed"), Type.Literal("llm-json")], {
			description: "Output format: 'summary' (brief overview), 'detailed' (full metadata), or 'llm-json' (structured JSON). Defaults to 'summary'.",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "If true, include entries marked as 'deleted'. Defaults to false." }),
	),
	showRetention: Type.Optional(
		Type.Boolean({ description: "If true, show retention analysis for each entry. Only applies to 'detailed' format. Defaults to false." }),
	),
});

export type ViewContextParams = Static<typeof VIEW_CONTEXT_PARAMETERS>;

export const VIEW_CONTEXT_TOOL_DEFINITION = {
	name: "view_context",
	label: "View context overview",
	description:
		"Create a readable overview of your conversation context, similar to what the user sees in the /manage_context picker. " +
		"Shows all turn units with their metadata, token counts, importance scores, and current selection status. " +
		"Use this to understand what's in your context before deciding what to compress or unselect.",
	promptSnippet: "view_context — get a readable overview of your conversation context",
	parameters: VIEW_CONTEXT_PARAMETERS,
};
