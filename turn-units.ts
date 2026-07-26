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
}

export function hasToolCalls(entry: SessionEntry): entry is SessionMessageEntry {
	return (
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((c) => c.type === "toolCall")
	);
}

export function oneLine(text: string, maxLen = 100): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat || "(empty)";
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

			units.push({
				groupId: entry.id,
				kind: "assistant_tool",
				entryIds,
				anchorEntry: entry,
				resultEntries,
				timestamp: entry.timestamp,
				preview: `tool call: ${callSummaries}${remaining.size > 0 ? " (awaiting result)" : ""}`,
				tokenEstimate: pieces.reduce((sum, m) => sum + estimateTokens(m), 0),
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
			units.push({
				groupId: entry.id,
				kind,
				entryIds: [entry.id],
				anchorEntry: entry,
				resultEntries: [],
				timestamp: entry.timestamp,
				preview: `${kind === "user" ? "user" : "assistant"}: ${oneLine(text)}`,
				tokenEstimate: messages.reduce((sum, m) => sum + estimateTokens(m), 0),
			});
			continue;
		}

		if (entry.type === "custom_message") {
			const text = contentToPreviewText(entry.content);
			const messages = sessionEntryToContextMessages(entry);
			units.push({
				groupId: entry.id,
				kind: "custom_message",
				entryIds: [entry.id],
				anchorEntry: entry,
				resultEntries: [],
				timestamp: entry.timestamp,
				preview: `${entry.customType}: ${oneLine(text)}`,
				tokenEstimate: messages.reduce((sum, m) => sum + estimateTokens(m), 0),
			});
			continue;
		}

		// compaction / branch_summary / model_change / thinking_level_change /
		// label / session_info / plain custom entries: not user-manageable,
		// left untouched by buildFilteredMessages() in context-filter.ts.
	}

	return units;
}
