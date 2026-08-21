/**
 * Turn units — the atomic rows shown in the picker.
 *
 * A "turn unit" is one user message, one tool-call-free assistant message,
 * one custom_message entry, OR (to keep every provider's tool_use/tool_result
 * pairing valid) one assistant message THAT MADE TOOL CALLS together with
 * every tool_result entry those calls produced. All entries in a unit are
 * selected / unselected / compressed / deleted together, as a single row.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

export type TurnUnitKind = "user" | "assistant_text" | "assistant_tool" | "custom_message";

/**
 * Structured metadata about a turn unit, designed for LLM decision-making.
 */
export interface TurnUnitMetadata {
	/** Clear heading summarizing the entry's purpose */
	heading: string;
	/** Entry type for classification */
	type: string;
	/** Timestamp in ISO format */
	timestamp: string;
	/** Detailed tool call information (if applicable) */
	toolCalls?: Array<{
		/** Tool function name */
		name: string;
		/** Tool arguments as JSON object */
		arguments: Record<string, unknown>;
		/** Tool result (if available) */
		result?: string;
		/** Human-readable description of what the tool did */
		description?: string;
	}>;
	/** Summary of the entry's content */
	summary: string;
	/** Key facts extracted for LLM retention decisions */
	keyFacts?: string[];
	/** Importance score (0-100) based on content analysis */
	importanceScore: number;
	/** Why this entry might be important to retain */
	retentionReason?: string;
}

export interface TurnUnit {
	groupId: string;
	kind: TurnUnitKind;
	/** All session entry ids this unit covers, in order (anchor first). */
	entryIds: string[];
	anchorEntry: SessionEntry;
	resultEntries: SessionMessageEntry[];
	timestamp: string;
	preview: string;
	tokenEstimate: number;
	/** Rich metadata for display and LLM decisions */
	metadata: TurnUnitMetadata;
}

export function hasToolCalls(entry: SessionEntry): entry is SessionMessageEntry {
	return (
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((c) => c.type === "toolCall")
	);
}

export function oneLine(text: string, maxLen = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat || "(empty)";
}

/**
 * Extract tool call arguments for display and LLM analysis.
 */
export function extractToolArguments(argumentsJson: unknown): Record<string, unknown> {
	if (typeof argumentsJson === "string") {
		try {
			return JSON.parse(argumentsJson) as Record<string, unknown>;
		} catch {
			return { raw: argumentsJson };
		}
	}
	return argumentsJson as Record<string, unknown>;
}

/**
 * Generate a descriptive heading for an entry based on its content.
 */
export function generateHeading(kind: TurnUnitKind, content: string): string {
	switch (kind) {
		case "user":
			if (content.length === 0) return "Empty message";
			const firstLine = content.split("\n")[0];
			return oneLine(firstLine, 60) || "User message";
		case "assistant_text":
			if (content.length === 0) return "Empty response";
			const responseFirstLine = content.split("\n")[0];
			return oneLine(responseFirstLine, 60) || "Assistant response";
		case "assistant_tool":
			return "Tool interactions";
		case "custom_message":
			return "Custom message";
	}
}

/**
 * Extract key facts from content that might be important for retention.
 */
export function extractKeyFacts(kind: TurnUnitKind, content: string): string[] {
	const facts: string[] = [];
	
	// Look for file paths
	const filePathRegex = /["']?([^"'\s]*\.(?:ts|tsx|js|jsx|json|md|css|scss|html|yaml|yml))["']?/g;
	const filePathMatches = content.match(filePathRegex);
	if (filePathMatches) {
		facts.push(`Files referenced: ${Array.from(new Set(filePathMatches)).join(", ")}`);
	}
	
	// Look for commands or code blocks
	const codeBlockRegex = /```(\w+)?\s*([\s\S]*?)```/g;
	const codeMatches = content.match(codeBlockRegex);
	if (codeMatches) {
		facts.push(`Code blocks: ${codeMatches.length}`);
	}
	
	// Look for important keywords
	const importantKeywords = ["error", "fixed", "added", "changed", "removed", "warning", "critical", "important"];
	const foundKeywords = importantKeywords.filter(k => content.toLowerCase().includes(k));
	if (foundKeywords.length > 0) {
		facts.push(`Contains: ${foundKeywords.join(", ")}`);
	}
	
	// Look for URLs or identifiers
	const urlRegex = /https?:\/\/[^\s"]+/g;
	const urlMatches = content.match(urlRegex);
	if (urlMatches) {
		facts.push(`URLs: ${urlMatches.length}`);
	}
	
	// Look for numbers that might be important
	const numberRegex = /\b\d+\b/g;
	const numbers = content.match(numberRegex);
	if (numbers && numbers.length > 3) {
		facts.push(`Contains ${numbers.length} numeric values`);
	}
	
	return facts;
}

/**
 * Calculate an importance score (0-100) for an entry.
 */
export function calculateImportanceScore(kind: TurnUnitKind, content: string, metadata?: TurnUnitMetadata): number {
	let score = 50; // Base score
	
	// Boost for user messages (instructions)
	if (kind === "user") {
		score += 20;
	}
	
	// Boost for tool interactions with results
	if (kind === "assistant_tool" && metadata?.toolCalls) {
		score += 15;
		// Bonus for successful tool calls
		const successfulTools = metadata.toolCalls.filter(tc => tc.description && tc.description.toLowerCase().includes("✓"));
		score += successfulTools.length * 5;
	}
	
	// Boost for entries with key facts
	if (metadata?.keyFacts && metadata.keyFacts.length > 0) {
		score += Math.min(metadata.keyFacts.length * 3, 15);
	}
	
	// Boost for entries with file paths
	if (content.includes(".ts") || content.includes(".js") || content.includes(".json")) {
		score += 10;
	}
	
	// Clamp to 0-100
	return Math.max(0, Math.min(100, score));
}

/**
 * Generate a retention reason based on content analysis.
 */
export function generateRetentionReason(kind: TurnUnitKind, content: string, metadata?: TurnUnitMetadata): string | undefined {
	if (kind === "user") {
		return "Contains user instructions or requirements";
	}
	
	if (kind === "assistant_tool" && metadata?.toolCalls) {
		if (metadata.toolCalls.some(tc => tc.description?.includes("error") || tc.description?.includes("failed"))) {
			return "Contains error information or debugging context";
		}
		
		const hasFileOps = metadata.toolCalls.some(tc => 
			tc.name.includes("file") || tc.name.includes("read") || tc.name.includes("write")
		);
		if (hasFileOps) {
			return "Contains file operations and changes";
		}
	}
	
	return "Maintains conversation context and decisions";
}

export function contentToPreviewText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((c) => (c.type === "text" ? c.text : "[image]")).join(" ");
}

export function buildTurnUnits(entries: SessionEntry[]): TurnUnit[] {
	const units: TurnUnit[] = [];

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];

		// Tool results are only ever consumed as part of an assistant_tool
		// group below — never start a unit on their own.
		if (entry.type === "message" && entry.message.role === "toolResult") continue;

		if (hasToolCalls(entry)) {
			const toolCallIds = entry.message.content.filter((c) => c.type === "toolCall").map((c) => c.id);
			const resultEntries: SessionMessageEntry[] = [];
			const entryIds = [entry.id];

			// Tool results are appended as their own entries right after the
			// assistant message that requested them (possibly interleaved
			// with other bookkeeping entries, never with another assistant
			// message before all of this turn's results have landed).
			let j = i + 1;
			const remaining = new Set(toolCallIds);
			while (j < entries.length && remaining.size > 0) {
				const candidate = entries[j];
				if (
					candidate.type === "message" &&
					candidate.message.role === "toolResult" &&
					remaining.has(candidate.message.toolCallId)
				) {
					resultEntries.push(candidate);
					entryIds.push(candidate.id);
					remaining.delete(candidate.message.toolCallId);
					j++;
					continue;
				}
				// Anything else means results for this turn have not all
				// arrived yet (mid-turn) — stop collecting, show what we have.
				break;
			}

			const callSummaries = entry.message.content
				.filter((c) => c.type === "toolCall")
				.map((c) => c.name)
				.join(", ");
			const pieces = [entry, ...resultEntries].flatMap((e) => sessionEntryToContextMessages(e));
			
			// Extract tool call details
			const toolCalls = entry.message.content
				.filter((c) => c.type === "toolCall")
				.map((call) => {
					const result = resultEntries.find(
						(r) => r.message.role === "toolResult" && r.message.toolCallId === call.id,
					);
					const resultText = result
						? contentToPreviewText(result.message.content)
						: "(no result yet)";
					return {
						name: call.name,
						arguments: extractToolArguments(call.arguments),
						result: resultText,
						description: resultText.startsWith("Error") || resultText.includes("failed")
							? `✗ ${resultText}`
							: `✓ ${resultText}`,
					};
				});
			
			// Generate heading, key facts, and retention reason
			const summary = `Executed ${callSummaries}${remaining.size > 0 ? " (awaiting results)" : ""}`;
			const contentForAnalysis = JSON.stringify(toolCalls, null, 2);
			const keyFacts = extractKeyFacts("assistant_tool", contentForAnalysis);
			const importanceScore = calculateImportanceScore("assistant_tool", contentForAnalysis, {
				heading: "Tool interactions",
				type: "tool_interaction",
				timestamp: entry.timestamp,
				toolCalls,
				summary,
				keyFacts,
			});
			
			units.push({
				groupId: entry.id,
				kind: "assistant_tool",
				entryIds,
				anchorEntry: entry,
				resultEntries,
				timestamp: entry.timestamp,
				preview: `tool call: ${callSummaries}${remaining.size > 0 ? " (awaiting result)" : ""}`,
				tokenEstimate: pieces.reduce((sum, m) => sum + estimateTokens(m), 0),
				metadata: {
					heading: "Tool interactions",
					type: "tool_interaction",
					timestamp: entry.timestamp,
					toolCalls,
					summary,
					keyFacts,
					importanceScore,
					retentionReason: generateRetentionReason("assistant_tool", contentForAnalysis, {
						heading: "Tool interactions",
						type: "tool_interaction",
						timestamp: entry.timestamp,
						toolCalls,
						summary,
						keyFacts,
					}),
				},
			});
			continue;
		}

		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
			const kind: TurnUnitKind = entry.message.role === "user" ? "user" : "assistant_text";
			const text =
				entry.message.role === "user"
					? contentToPreviewText(entry.message.content)
					: entry.message.content
							.filter((c): c is TextContent => c.type === "text")
							.map((c) => c.text)
							.join(" ");
			const messages = sessionEntryToContextMessages(entry);
			
			// Generate metadata for regular messages
			const heading = generateHeading(kind, text);
			const keyFacts = extractKeyFacts(kind, text);
			const importanceScore = calculateImportanceScore(kind, text);
			
			units.push({
				groupId: entry.id,
				kind,
				entryIds: [entry.id],
				anchorEntry: entry,
				resultEntries: [],
				timestamp: entry.timestamp,
				preview: `${kind === "user" ? "user" : "assistant"}: ${oneLine(text)}`,
				tokenEstimate: messages.reduce((sum, m) => sum + estimateTokens(m), 0),
				metadata: {
					heading,
					type: kind === "user" ? "user_message" : "assistant_response",
					timestamp: entry.timestamp,
					summary: oneLine(text, 200),
					keyFacts,
					importanceScore,
					retentionReason: generateRetentionReason(kind, text, {
						heading,
						type: kind === "user" ? "user_message" : "assistant_response",
						timestamp: entry.timestamp,
						summary: oneLine(text, 200),
						keyFacts,
						importanceScore,
					}),
				},
			});
			continue;
		}

		if (entry.type === "custom_message") {
			const text = contentToPreviewText(entry.content);
			const messages = sessionEntryToContextMessages(entry);
			
			// Generate metadata for custom messages
			const heading = generateHeading("custom_message", text);
			const keyFacts = extractKeyFacts("custom_message", text);
			const importanceScore = calculateImportanceScore("custom_message", text);
			
			units.push({
				groupId: entry.id,
				kind: "custom_message",
				entryIds: [entry.id],
				anchorEntry: entry,
				resultEntries: [],
				timestamp: entry.timestamp,
				preview: `${entry.customType}: ${oneLine(text)}`,
				tokenEstimate: messages.reduce((sum, m) => sum + estimateTokens(m), 0),
				metadata: {
					heading,
					type: `custom_${entry.customType}`,
					timestamp: entry.timestamp,
					summary: oneLine(text, 200),
					keyFacts,
					importanceScore,
					retentionReason: generateRetentionReason("custom_message", text, {
						heading,
						type: `custom_${entry.customType}`,
						timestamp: entry.timestamp,
						summary: oneLine(text, 200),
						keyFacts,
						importanceScore,
					}),
				},
			});
			continue;
		}

		// compaction / branch_summary / model_change / thinking_level_change /
		// label / session_info / plain custom entries: not user-manageable,
		// left untouched by buildFilteredMessages() in context-filter.ts.
	}

	return units;
}
