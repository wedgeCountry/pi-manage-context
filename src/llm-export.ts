/**
 * LLM-optimized export format for memory entries.
 *
 * Structured JSON output that an LLM can parse to make decisions about what
 * to keep or compress in the conversation context. Contains only honest,
 * cheaply computed fields — no fabricated importance scores or extracted
 * "key facts"; the consumer judges the content itself.
 */

import type { TurnUnit } from "./turn-units.ts";

/**
 * Structured memory entry designed for LLM consumption.
 */
export interface LLMMemoryEntry {
	/** Unique identifier for this entry */
	id: string;
	/** Entry type for classification */
	type: string;
	/** Human-readable heading */
	heading: string;
	/** Timestamp in ISO format */
	timestamp: string;
	/** Token count */
	tokenCount: number;
	/** Tool calls with arguments (if applicable) */
	toolCalls?: Array<{
		name: string;
		arguments: Record<string, unknown>;
		result?: string;
		description?: string;
	}>;
	/** Summary of the content */
	content: string;
}

/**
 * Convert a TurnUnit to an LLM-optimized memory entry.
 */
export function toLLMMemoryEntry(unit: TurnUnit): LLMMemoryEntry {
	const entry: LLMMemoryEntry = {
		id: unit.groupId,
		type: unit.metadata.type,
		heading: unit.metadata.heading,
		timestamp: unit.metadata.timestamp,
		tokenCount: unit.tokenEstimate,
		content: unit.metadata.summary,
	};

	if (unit.metadata.toolCalls) {
		entry.toolCalls = unit.metadata.toolCalls;
	}

	return entry;
}
