/**
 * LLM-optimized export format for memory entries.
 * 
 * This module provides structured JSON output that an LLM can easily parse
 * to make informed decisions about what to keep or compress in the conversation context.
 */

import type { TurnUnit } from "./turn-units.ts";

/**
 * Structured memory entry designed for LLM consumption.
 */
export interface LLMMemoryEntry {
	/** Unique identifier for this entry */
	id: string;
	/** Entry type for classification */
	type: "user_message" | "assistant_response" | "tool_interaction" | "custom_message";
	/** Human-readable heading */
	heading: string;
	/** Timestamp in ISO format */
	timestamp: string;
	/** Token count */
	tokenCount: number;
	/** Auto-calculated importance score (0-100) */
	importanceScore: number;
	/** Why this entry is important to retain */
	retentionReason: string;
	/** Tool calls with arguments (if applicable) */
	toolCalls?: Array<{
		name: string;
		arguments: Record<string, unknown>;
		result?: string;
		description?: string;
	}>;
	/** Key facts extracted from the entry */
	keyFacts: string[];
	/** Summary of the content */
	content: string;
}

/**
 * Convert a TurnUnit to an LLM-optimized memory entry.
 */
export function toLLMMemoryEntry(unit: TurnUnit): LLMMemoryEntry {
	const entry: LLMMemoryEntry = {
		id: unit.groupId,
		type: unit.metadata.type as "user_message" | "assistant_response" | "tool_interaction" | "custom_message",
		heading: unit.metadata.heading,
		timestamp: unit.metadata.timestamp,
		tokenCount: unit.tokenEstimate,
		importanceScore: unit.metadata.importanceScore,
		retentionReason: unit.metadata.retentionReason || "Maintains conversation context",
		keyFacts: unit.metadata.keyFacts || [],
		content: unit.metadata.summary,
	};

	if (unit.metadata.toolCalls) {
		entry.toolCalls = unit.metadata.toolCalls;
	}

	return entry;
}

/**
 * Export all units as LLM-optimized JSON.
 */
export function exportToLLMJSON(units: TurnUnit[]): string {
	const entries = units.map(unit => toLLMMemoryEntry(unit));
	return JSON.stringify(entries, null, 2);
}

/**
 * Generate a retention decision prompt for the LLM.
 */
export function generateRetentionPrompt(entries: LLMMemoryEntry[]): string {
	const parts: string[] = [];
	
	parts.push(`You are analyzing conversation context to determine which entries to retain or compress.`);
	parts.push(`Each entry has been scored for importance (0-100) and includes retention reasons.`);
	parts.push(``);
	parts.push(`Entries to analyze:`);
	parts.push(``);
	
	entries.forEach((entry, idx) => {
		parts.push(`Entry ${idx + 1}:`);
		parts.push(`  ID: ${entry.id}`);
		parts.push(`  Type: ${entry.type}`);
		parts.push(`  Heading: ${entry.heading}`);
		parts.push(`  Token Count: ${entry.tokenCount}`);
		parts.push(`  Importance Score: ${entry.importanceScore}/100`);
		parts.push(`  Retention Reason: ${entry.retentionReason}`);
		
		if (entry.toolCalls && entry.toolCalls.length > 0) {
			parts.push(`  Tool Calls: ${entry.toolCalls.length}`);
			entry.toolCalls.forEach((toolCall, toolIdx) => {
				parts.push(`    ${toolIdx + 1}. ${toolCall.name} - ${toolCall.result ? "✓ completed" : "pending"}`);
			});
		}
		
		if (entry.keyFacts.length > 0) {
			parts.push(`  Key Facts: ${entry.keyFacts.length}`);
			entry.keyFacts.forEach((fact, factIdx) => {
				parts.push(`    • ${fact}`);
			});
		}
		
		parts.push(``);
	});
	
	parts.push(`Decision criteria:`);
	parts.push(`- Entries with importance score 90-100 should generally be KEPT uncompressed`);
	parts.push(`- Entries with importance score 50-89 can be compressed if token count > 500`);
	parts.push(`- Entries with importance score < 50 can be compressed or deleted`);
	parts.push(`- Tool interactions with results should be evaluated based on key facts`);
	parts.push(`- File operations and code changes are usually important to retain`);
	parts.push(``);
	parts.push(`Please output your recommendations in this format:`);
	parts.push(`RECOMMENDATION: [keep|compress|delete] for each entry with reasoning`);
	
	return parts.join("\n");
}
