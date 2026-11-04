/**
 * Turn units — the atomic rows shown in the picker.
 *
 * A "turn unit" is one user message, one tool-call-free assistant message,
 * one custom_message entry, OR (to keep every provider's tool_use/tool_result
 * pairing valid) one assistant message THAT MADE TOOL CALLS together with
 * every tool_result entry those calls produced. All entries in a unit are
 * selected / unselected / compressed / deleted together, as a single row.
 *
 * Two build levels:
 * - buildTurnUnitGroups() — cheap, structural grouping only. Used on hot
 *   paths (the "context" event fires on every LLM call) where full metadata
 *   would be wasted work.
 * - buildTurnUnits() — groups plus display metadata (heading, preview,
 *   summary, tool calls). Used by the picker, the tools, and the export.
 */

import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

export type TurnUnitKind = "user" | "assistant_text" | "assistant_tool" | "custom_message";

/**
 * Structured metadata about a turn unit. Deliberately limited to what is
 * cheap to compute and honest to report — heading, type, timestamps, tool
 * call details, and a capped content summary. No importance scores or
 * extracted "key facts": those were regex heuristics whose fabricated
 * numbers leaked into LLM-facing output and steered retention decisions
 * worse than no numbers at all.
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
}

/**
 * The structural half of a turn unit: which session entries belong together
 * and why. Everything the context filter needs, nothing more.
 */
export interface TurnUnitGroup {
	groupId: string;
	kind: TurnUnitKind;
	/** All session entry ids this unit covers, in order (anchor first). */
	entryIds: string[];
	anchorEntry: SessionEntry;
	resultEntries: SessionMessageEntry[];
}

export interface TurnUnit extends TurnUnitGroup {
	timestamp: string;
	preview: string;
	tokenEstimate: number;
	/** Display/LLM metadata (heading, summary, tool calls). */
	metadata: TurnUnitMetadata;
}

/** A message entry whose message is specifically an assistant message that made tool calls. */
export interface AssistantToolCallEntry extends SessionMessageEntry {
	message: AssistantMessage;
}

export function hasToolCalls(entry: SessionEntry): entry is AssistantToolCallEntry {
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
 * Like oneLine(), but keeps line breaks intact — for metadata.summary, whose
 * consumers (the preview panes, markdown export) split on "\n" to render
 * multi-line content. oneLine() would collapse those breaks into spaces
 * before anyone got a chance to split on them.
 */
export function preserveLineBreaks(text: string, maxLen = 4000): string {
	// Normalize line endings and drop trailing whitespace per line, but leave
	// the breaks themselves alone.
	const normalized = text.replace(/\r\n/g, "\n").trim();
	return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized || "(empty)";
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
			return oneLine(content.split("\n")[0], 60) || "User message";
		case "assistant_text":
			if (content.length === 0) return "Empty response";
			return oneLine(content.split("\n")[0], 60) || "Assistant response";
		case "assistant_tool":
			return "Tool interactions";
		case "custom_message":
			return "Custom message";
	}
}

export function contentToPreviewText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((c) => (c.type === "text" ? c.text : "[image]")).join(" ");
}

/** Groups raw session entries into structural turn-unit groups, without any metadata work. */
export function buildTurnUnitGroups(entries: SessionEntry[]): TurnUnitGroup[] {
	const groups: TurnUnitGroup[] = [];

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
				// Non-message bookkeeping entries (state saves, compaction
				// markers, labels, ...) can legitimately land between a tool
				// call and its result — e.g. a tool's own execute() persisting
				// state before returning. Skip over them without ending
				// collection; they're picked up on their own turn through the
				// pass-through path below.
				if (candidate.type !== "message") {
					j++;
					continue;
				}
				// A genuine message that isn't one of this turn's pending
				// results means results for this turn have not all arrived
				// yet (mid-turn) — stop collecting, show what we have.
				break;
			}

			groups.push({
				groupId: entry.id,
				kind: "assistant_tool",
				entryIds,
				anchorEntry: entry,
				resultEntries,
			});
			continue;
		}

		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
			groups.push({
				groupId: entry.id,
				kind: entry.message.role === "user" ? "user" : "assistant_text",
				entryIds: [entry.id],
				anchorEntry: entry,
				resultEntries: [],
			});
			continue;
		}

		if (entry.type === "custom_message") {
			groups.push({
				groupId: entry.id,
				kind: "custom_message",
				entryIds: [entry.id],
				anchorEntry: entry,
				resultEntries: [],
			});
			continue;
		}

		// compaction / branch_summary / model_change / thinking_level_change /
		// label / session_info / plain custom entries: not user-manageable,
		// left untouched by buildFilteredMessages() in context-filter.ts.
	}

	return groups;
}

/** Cheap facts shared by every unit kind: text, heading, token estimate. */
function baseUnitTexts(group: TurnUnitGroup): { text: string; heading: string } {
	if (group.kind === "assistant_tool") {
		const entry = group.anchorEntry;
		if (!hasToolCalls(entry)) return { text: "", heading: "Tool interactions" };
		return { text: "", heading: "Tool interactions" };
	}
	if (group.kind === "custom_message") {
		if (group.anchorEntry.type !== "custom_message") return { text: "", heading: "Custom message" };
		const text = contentToPreviewText(group.anchorEntry.content);
		return { text, heading: generateHeading("custom_message", text) };
	}
	if (group.anchorEntry.type !== "message") return { text: "", heading: "" };
	const role = group.anchorEntry.message.role;
	if (role !== "user" && role !== "assistant") return { text: "", heading: "" };
	const text =
		role === "user"
			? contentToPreviewText(group.anchorEntry.message.content)
			: group.anchorEntry.message.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join(" ");
	const kind = role === "user" ? "user" : "assistant_text";
	return { text, heading: generateHeading(kind, text) };
}

/** Metadata (heading, summary, tool calls) for one structural group. */
export function enrichGroup(group: TurnUnitGroup): TurnUnitMetadata {
	const timestamp = group.anchorEntry.timestamp;

	if (group.kind === "assistant_tool") {
		const entry = group.anchorEntry;
		const toolCalls =
			entry.type === "message" && entry.message.role === "assistant"
				? entry.message.content
						.filter((c) => c.type === "toolCall")
						.map((call) => {
							const result = group.resultEntries.find(
								(r) => r.message.role === "toolResult" && r.message.toolCallId === call.id,
							);
							// Capped like every other text path here (preserveLineBreaks is used
							// for user/assistant/custom_message summaries below) — an uncapped
							// tool result (e.g. a large file read) would make this unit's own
							// list/textMatch footprint as big as the context the
							// manage-context tool exists to shrink.
							const resultText =
								result && result.message.role === "toolResult"
									? preserveLineBreaks(contentToPreviewText(result.message.content))
									: "(no result yet)";
							return {
								name: call.name,
								arguments: extractToolArguments(call.arguments),
								result: resultText,
								description:
									resultText.startsWith("Error") || resultText.includes("failed")
										? `✗ ${resultText}`
										: `✓ ${resultText}`,
							};
						})
				: [];
		const callSummaries = toolCalls.map((c) => c.name).join(", ");
		return {
			heading: "Tool interactions",
			type: "tool_interaction",
			timestamp,
			toolCalls,
			summary: `Executed ${callSummaries}${group.resultEntries.length < toolCalls.length ? " (awaiting results)" : ""}`,
		};
	}

	const { text, heading } = baseUnitTexts(group);
	return {
		heading,
		type:
			group.kind === "user"
				? "user_message"
				: group.kind === "assistant_text"
					? "assistant_response"
					: group.kind === "custom_message" && group.anchorEntry.type === "custom_message"
						? `custom_${group.anchorEntry.customType}`
						: "custom_message",
		timestamp,
		summary: preserveLineBreaks(text),
	};
}

export function buildTurnUnits(entries: SessionEntry[]): TurnUnit[] {
	return buildTurnUnitGroups(entries).map((group) => {
		const metadata = enrichGroup(group);
		const pieces = [group.anchorEntry, ...group.resultEntries].flatMap((e) => sessionEntryToContextMessages(e));
		return {
			...group,
			timestamp: group.anchorEntry.timestamp,
			preview:
				group.kind === "assistant_tool"
					? `tool call: ${metadata.summary.replace(/^Executed /, "")}`
					: `${group.kind === "user" ? "user" : group.kind === "assistant_text" ? "assistant" : "custom"}: ${oneLine(metadata.summary)}`,
			tokenEstimate: pieces.reduce((sum, m) => sum + estimateTokens(m), 0),
			metadata,
		};
	});
}
