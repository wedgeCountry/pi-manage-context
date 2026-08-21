/**
 * Markdown export functionality for turn units.
 * 
 * This module provides methods to export context entries as formatted markdown
 * with structured metadata, making them easy to read, share, and analyze.
 */

import type { TurnUnit } from "./turn-units.ts";
import { oneLine } from "./turn-units.ts";

/**
 * Export a single turn unit as markdown.
 */
export function exportUnitToMarkdown(unit: TurnUnit): string {
	const lines: string[] = [];
	
	// Header
	lines.push(`# ${unit.metadata.heading}`);
	lines.push("");
	
	// Metadata
	lines.push(`**Type**: ${unit.metadata.type}`);
	lines.push(`**Timestamp**: ${unit.metadata.timestamp}`);
	lines.push(`**Token Count**: ${unit.tokenEstimate}`);
	lines.push(`**Importance Score**: ${unit.metadata.importanceScore}/100`);
	lines.push("");
	
	// Tool calls (if applicable)
	if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
		lines.push("## Tool Calls");
		lines.push("");
		unit.metadata.toolCalls.forEach((toolCall, idx) => {
			lines.push(`### ${idx + 1}. ${toolCall.name}`);
			lines.push("");
			lines.push("**Arguments**:");
			lines.push("```json");
			lines.push(JSON.stringify(toolCall.arguments, null, 2));
			lines.push("```");
			lines.push("");
			
			if (toolCall.result) {
				lines.push("**Result**:");
				lines.push(toolCall.description || toolCall.result);
				lines.push("");
			}
		});
	}
	
	// Key facts
	if (unit.metadata.keyFacts && unit.metadata.keyFacts.length > 0) {
		lines.push("## Key Facts");
		lines.push("");
		unit.metadata.keyFacts.forEach(fact => {
			lines.push(`- ${fact}`);
		});
		lines.push("");
	}
	
	// Retention reason
	if (unit.metadata.retentionReason) {
		lines.push("## Retention Reason");
		lines.push("");
		lines.push(unit.metadata.retentionReason);
		lines.push("");
	}
	
	// Content
	lines.push("## Content");
	lines.push("");
	const contentLines = unit.metadata.summary.split("\n");
	contentLines.forEach(line => {
		lines.push(line);
	});
	if (contentLines.length > 10) {
		lines.push(`... (${contentLines.length - 10} more lines)`);
	}
	lines.push("");
	
	return lines.join("\n");
}

/**
 * Export multiple turn units as a single markdown document.
 */
export function exportUnitsToMarkdown(
	units: TurnUnit[],
	options: {
		title?: string;
		groupByType?: boolean;
		includeSummary?: boolean;
	} = {},
): string {
	const lines: string[] = [];
	
	const title = options.title || "Context Export";
	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`**Exported**: ${new Date().toISOString()}`);
	lines.push(`**Total Entries**: ${units.length}`);
	lines.push("");
	
	// Group by type if requested
	if (options.groupByType) {
		const typeGroups: Record<string, TurnUnit[]> = {};
		units.forEach(unit => {
			if (!typeGroups[unit.metadata.type]) {
				typeGroups[unit.metadata.type] = [];
			}
			typeGroups[unit.metadata.type].push(unit);
		});
		
		Object.entries(typeGroups).forEach(([type, typeUnits]) => {
			lines.push(`## ${type}`);
			lines.push("");
			typeUnits.forEach(unit => {
				lines.push(exportUnitToMarkdown(unit));
				lines.push("---");
				lines.push("");
			});
		});
	} else {
		// Export all units sequentially
		units.forEach((unit, idx) => {
			lines.push(`## Entry ${idx + 1}: ${unit.metadata.heading}`);
			lines.push("");
			lines.push(exportUnitToMarkdown(unit));
			lines.push("---");
			lines.push("");
		});
	}
	
	// Optional summary
	if (options.includeSummary) {
		lines.push("## Summary");
		lines.push("");
		
		const totalTokens = units.reduce((sum, u) => sum + u.tokenEstimate, 0);
		const avgImportance = units.length > 0 
			? Math.round(units.reduce((sum, u) => sum + u.metadata.importanceScore, 0) / units.length)
			: 0;
		
		lines.push(`- **Total Entries**: ${units.length}`);
		lines.push(`- **Total Tokens**: ${totalTokens}`);
		lines.push(`- **Average Importance**: ${avgImportance}/100`);
		
		// Count by type
		const typeCounts: Record<string, number> = {};
		units.forEach(unit => {
			typeCounts[unit.metadata.type] = (typeCounts[unit.metadata.type] || 0) + 1;
		});
		
		lines.push(`- **By Type**:`);
		Object.entries(typeCounts).forEach(([type, count]) => {
			lines.push(`  - ${type}: ${count}`);
		});
		lines.push("");
	}
	
	return lines.join("\n");
}

/**
 * Export selected entries with marks as markdown.
 */
export function exportFilteredUnitsToMarkdown(
	units: TurnUnit[],
	marks: Record<string, { mark: string }>,
	options: {
		title?: string;
		groupByType?: boolean;
		includeSummary?: boolean;
		onlySelected?: boolean;
	},
): string {
	const filteredUnits = options.onlySelected
		? units.filter(unit => marks[unit.groupId]?.mark === "selected")
		: units;
	
	return exportUnitsToMarkdown(filteredUnits, options);
}
