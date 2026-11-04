/**
 * Rebuilds the outgoing message array for one LLM call by applying the
 * current marks (selected / unselected / compressed / deleted) to turn
 * unit groups.
 *
 * Works on the cheap structural groups (buildTurnUnitGroups) rather than
 * fully enriched units: this runs on the "context" event, i.e. every LLM
 * call, so it must not pay for metadata it never reads.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import type { ManageContextState } from "./state.ts";
import type { TurnUnitGroup } from "./turn-units.ts";

function cloneWithReplacedContent(message: AgentMessage, compressedText: string): AgentMessage {
	const anyMsg = message as unknown as Record<string, unknown> & { role: string };
	if (anyMsg.role === "assistant") {
		return { ...(message as any), content: [{ type: "text", text: compressedText }] };
	}
	// user / custom / toolResult-shaped originals all accept a plain string content.
	return { ...(message as any), content: compressedText };
}

export function buildCompressedReplacement(group: TurnUnitGroup, compressedText: string): AgentMessage[] {
	if (group.kind === "assistant_tool") {
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
	const [original, ...rest] = sessionEntryToContextMessages(group.anchorEntry);
	return [cloneWithReplacedContent(original, compressedText), ...rest];
}

/** Rebuilds the outgoing message array for one LLM call, applying all marks. */
export function buildFilteredMessages(
	entries: SessionEntry[],
	units: TurnUnitGroup[],
	state: ManageContextState,
): AgentMessage[] {
	const unitByEntryId = new Map<string, TurnUnitGroup>();
	for (const u of units) for (const id of u.entryIds) unitByEntryId.set(id, u);
	const entryById = new Map(entries.map((e) => [e.id, e]));

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
		for (const id of unit.entryIds) out.push(...sessionEntryToContextMessages(entryById.get(id)!));
	}

	return out;
}
