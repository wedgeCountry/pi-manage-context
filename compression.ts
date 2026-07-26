/**
 * Compression sub-agent: turns a single turn unit into a short text summary
 * via a one-off LLM call, used when a unit is marked "compressed".
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import type { ManageContextState } from "./state.js";
import { contentToPreviewText } from "./turn-units.js";
import type { TurnUnit } from "./turn-units.js";

const COMPRESSION_SYSTEM_PROMPT = `You compress a single entry from an AI coding agent's conversation history so it can be kept in context at a fraction of the size.

You will be given one turn: a user message, an assistant message, or a tool call together with its result.

Preserve everything a future turn could still need: concrete facts, decisions, file paths, identifiers, numbers, error messages, and outcomes. Drop conversational filler, restated context, and verbose formatting.

Do not add commentary, opinions, or anything not present in the source. Output only the compressed replacement text, nothing else — no preamble, no markdown fences.`;

const MAX_SOURCE_CHARS = 20_000;

function truncate(text: string, max = MAX_SOURCE_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

export function renderUnitForCompression(unit: TurnUnit): string {
	if (unit.kind === "assistant_tool") {
		const assistantMsg = (unit.anchorEntry as SessionMessageEntry).message;
		if (assistantMsg.role !== "assistant") return ""; // unreachable, narrows the type
		const calls = assistantMsg.content.filter((c) => c.type === "toolCall");
		const parts = calls.map((call, idx) => {
			const result = unit.resultEntries.find(
				(r) => r.message.role === "toolResult" && r.message.toolCallId === call.id,
			);
			const resultText =
				result && result.message.role === "toolResult"
					? contentToPreviewText(result.message.content)
					: "(no result yet)";
			return `Tool call ${idx + 1}: ${call.name}(${JSON.stringify(call.arguments)})\nResult: ${truncate(resultText)}`;
		});
		return parts.join("\n\n");
	}
	const [message] = sessionEntryToContextMessages(unit.anchorEntry);
	const anyMsg = message as Record<string, unknown>;
	const content = anyMsg.content as string | (TextContent | ImageContent)[];
	return truncate(contentToPreviewText(content));
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
