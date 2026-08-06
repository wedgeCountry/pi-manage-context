/**
 * Rebuilds the outgoing message array for one LLM call by applying the
 * current marks (selected / unselected / compressed / deleted) to turn
 * units.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import type { ManageContextState } from "./state.ts";
import type { TurnUnit } from "./turn-units.ts";

function cloneWithReplacedContent(message: AgentMessage, compressedText: string): AgentMessage {
	const anyMsg = message as Record<string, unknown> & { role: string };
	if (anyMsg.role === "assistant") {
		return { ...(message as any), content: [{ type: "text", text: compressedText }] };
	}
	// user / custom / toolResult-shaped originals all accept a plain string content.
	return { ...(message as any), content: compressedText };
}

export function buildCompressedReplacement(unit: TurnUnit, compressedText: string): AgentMessage[] {
	if (unit.kind === "assistant_tool") {
		// No single original message can safely stand in for a whole
		// call+result group, so we synthesize a plain user-role note. This is
		// always structurally valid, regardless of provider.
		return [
			{
				role: "user",
				content: `[Context compression — originally a tool call: ${compressedText}]`,
				timestamp: Date.now(),
			} as AgentMessage,
		];
	}
	// sessionEntryToContextMessages() currently expands a "user"/"assistant"/
	// "custom_message" entry to exactly one AgentMessage, but that's a library
	// invariant we don't control — only the first message stands in for the
	// compressed summary; anything beyond it is kept as-is rather than
	// silently dropped.
	const [original, ...rest] = sessionEntryToContextMessages(unit.anchorEntry);
	return [cloneWithReplacedContent(original, compressedText), ...rest];
}

/** Rebuilds the outgoing message array for one LLM call, applying all marks. */
export function buildFilteredMessages(
	entries: SessionEntry[],
	units: TurnUnit[],
	state: ManageContextState,
): AgentMessage[] {
	const unitByEntryId = new Map<string, TurnUnit>();
	for (const u of units) for (const id of u.entryIds) unitByEntryId.set(id, u);

	const out: AgentMessage[] = [];
	const emitted = new Set<string>();

	for (const entry of entries) {
		const unit = unitByEntryId.get(entry.id);
		if (!unit) {
			// Bookkeeping entries (compaction summaries, branch summaries,
			// model/thinking-level changes, labels, ...) pass through
			// untouched — sessionEntryToContextMessages() already knows
			// which of these contribute nothing to context.
			out.push(...sessionEntryToContextMessages(entry));
			continue;
		}
		if (emitted.has(unit.groupId)) continue; // whole unit already handled at its anchor position
		emitted.add(unit.groupId);

		const info = state.marks[unit.groupId];
		const mark = info?.mark ?? "selected";

		if (mark === "deleted" || mark === "unselected") continue;
		if (info?.compressedText) {
			// Realized compressions stay substituted even after the mark
			// resolves back to "selected" once compaction succeeds.
			out.push(...buildCompressedReplacement(unit, info.compressedText));
			continue;
		}
		// "selected" (default), or "compressed" not yet realized this session
		// (e.g. process was interrupted before Esc) — fall back to originals.
		for (const id of unit.entryIds) out.push(...sessionEntryToContextMessages(entries.find((e) => e.id === id)!));
	}

	return out;
}
