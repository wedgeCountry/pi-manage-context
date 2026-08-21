/**
 * Compression sub-agent: turns a single turn unit into a short text summary
 * via a one-off LLM call, used when a unit is marked "compressed".
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import type { ManageContextState } from "./state.ts";
import { contentToPreviewText, extractToolArguments, oneLine } from "./turn-units.ts";
import type { TurnUnit } from "./turn-units.ts";

const COMPRESSION_SYSTEM_PROMPT = `You compress a single entry from an AI coding agent's conversation history so it can be kept in context at a fraction of the size.

You will be given one turn: a user message, an assistant message, or a tool call together with its result.

The input will include structured metadata with:
- HEADING: A title describing the entry
- TYPE: The entry type (user_message, assistant_response, tool_interaction)
- TIMESTAMP: When the entry occurred
- TOOL_CALLS (if applicable): Structured tool call information with names, arguments, and results
- CONTENT: The main content to compress
- KEY_FACTS: Important facts that should be preserved
- IMPORTANCE_SCORE: How important this entry is (0-100)

Preserve everything a future turn could still need: concrete facts, decisions, file paths, identifiers, numbers, error messages, and outcomes. Drop conversational filler, restated context, and verbose formatting.

For tool interactions:
- Keep the tool names and purposes
- Preserve critical argument values (especially file paths, query parameters, configurations)
- Include key results, especially errors, warnings, or important outputs

Output a compressed replacement that maintains all essential information in a concise format. Do not add commentary, opinions, or anything not present in the source. Output only the compressed replacement text, nothing else — no preamble, no markdown fences.`;

const MAX_SOURCE_CHARS = 20_000;

function truncate(text: string, max = MAX_SOURCE_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

export function renderUnitForCompression(unit: TurnUnit): string {
	const parts: string[] = [];
	
	// Add structured metadata header
	parts.push(`HEADING: ${unit.metadata.heading}`);
	parts.push(`TYPE: ${unit.metadata.type}`);
	parts.push(`TIMESTAMP: ${unit.metadata.timestamp}`);
	parts.push(`TOKENS: ${unit.tokenEstimate}`);
	parts.push(`IMPORTANCE_SCORE: ${unit.metadata.importanceScore}/100`);
	parts.push(`RETENTION_REASON: ${unit.metadata.retentionReason || "N/A"}`);
	parts.push("");
	
	// Add tool calls section if applicable
	if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
		parts.push(`TOOL_CALLS (${unit.metadata.toolCalls.length} total):`);
		unit.metadata.toolCalls.forEach((toolCall, idx) => {
			parts.push(`  ${idx + 1}. ${toolCall.name}`);
			parts.push(`     Arguments: ${JSON.stringify(toolCall.arguments)}`);
			if (toolCall.result) {
				parts.push(`     Result: ${toolCall.result}`);
			}
		});
		parts.push("");
	}
	
	// Add key facts section
	if (unit.metadata.keyFacts && unit.metadata.keyFacts.length > 0) {
		parts.push(`KEY_FACTS (${unit.metadata.keyFacts.length} total):`);
		unit.metadata.keyFacts.forEach(fact => {
			parts.push(`  • ${fact}`);
		});
		parts.push("");
	}
	
	// Add the main content
	parts.push(`CONTENT:`);
	if (unit.kind === "assistant_tool") {
		const assistantMsg = (unit.anchorEntry as SessionMessageEntry).message;
		if (assistantMsg.role !== "assistant") return ""; // unreachable, narrows the type
		const calls = assistantMsg.content.filter((c) => c.type === "toolCall");
		const callParts = calls.map((call, idx) => {
			const result = unit.resultEntries.find(
				(r) => r.message.role === "toolResult" && r.message.toolCallId === call.id,
			);
			const resultText =
				result && result.message.role === "toolResult"
					? contentToPreviewText(result.message.content)
					: "(no result yet)";
			const argumentsJson = extractToolArguments(call.arguments);
			return `Tool call ${idx + 1}: ${call.name}(${JSON.stringify(argumentsJson)})\nResult: ${truncate(resultText)}`;
		});
		parts.push(callParts.join("\n\n"));
	} else {
		const [message] = sessionEntryToContextMessages(unit.anchorEntry);
		const anyMsg = message as Record<string, unknown>;
		const content = anyMsg.content as string | (TextContent | ImageContent)[];
		parts.push(truncate(contentToPreviewText(content)));
	}
	
	return parts.join("\n");
}

export async function resolveCompressionModel(
	ctx: ExtensionContext,
	state: ManageContextState,
): Promise<Model<Api> | undefined> {
	if (state.compressionModel) {
		const found = ctx.modelRegistry.find(state.compressionModel.provider, state.compressionModel.id);
		if (found) return found;
	}
	return ctx.model;
}

export async function compressUnit(
	unit: TurnUnit,
	model: Model<Api>,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key configured for ${model.provider}`);

	const sourceText = renderUnitForCompression(unit);
	const response = await complete(
		model,
		{
			systemPrompt: COMPRESSION_SYSTEM_PROMPT,
			messages: [{ role: "user", content: sourceText, timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: 1024,
			signal,
			cacheRetention: "none",
			sessionId: uuidv7(),
		},
	);

	const text = response.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("compression returned empty output");
	return text;
}

/**
 * Generate a retention decision summary for LLM guidance.
 */
export function generateRetentionSummary(unit: TurnUnit): string {
	const parts: string[] = [];
	
	parts.push(`Entry Type: ${unit.metadata.type}`);
	parts.push(`Heading: ${unit.metadata.heading}`);
	parts.push(`Importance Score: ${unit.metadata.importanceScore}/100`);
	parts.push(`Token Count: ${unit.tokenEstimate}`);
	
	if (unit.metadata.toolCalls) {
		parts.push(`Tool Calls: ${unit.metadata.toolCalls.length}`);
	}
	
	if (unit.metadata.keyFacts) {
		parts.push(`Key Facts: ${unit.metadata.keyFacts.length}`);
	}
	
	parts.push(`Retention Reason: ${unit.metadata.retentionReason}`);
	
	return parts.join("\n");
}
