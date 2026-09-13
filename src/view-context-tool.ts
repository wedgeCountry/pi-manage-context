/**
 * view_context — provides the AI agent with a readable overview of its
 * conversation context, similar to what the user sees in the /manage_context
 * picker UI. Returns a formatted list of all turn units with their metadata,
 * making it easy for the model to understand what's in context without
 * needing to parse raw messages.
 *
 * Unlike manage_context_select (which is for programmatic select/unselect
 * operations), this tool is designed for human-readable inspection and
 * awareness of the current context state.
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { loadState } from "./state.ts";
import { buildTurnUnits, type TurnUnit } from "./turn-units.ts";
import { toLLMMemoryEntry } from "./llm-export.ts";

interface ViewContextParams {
	/**
	 * Output format: "summary" (brief overview), "detailed" (full metadata),
	 * or "llm-json" (structured JSON for programmatic use).
	 * Defaults to "summary".
	 */
	format?: "summary" | "detailed" | "llm-json";
	/**
	 * If true, include entries marked as "deleted" in the output.
	 * Defaults to false (deleted entries are hidden).
	 */
	includeDeleted?: boolean;
	/**
	 * If true, show retention analysis for each entry (why it's being kept).
	 * Only applies to "detailed" format. Defaults to false.
	 */
	showRetention?: boolean;
}

function formatSummary(units: TurnUnit[], state: any, showRetention: boolean): string {
	const lines: string[] = [];
	
	lines.push("═".repeat(60));
	lines.push("  CONTEXT OVERVIEW");
	lines.push("═".repeat(60));
	lines.push("");
	lines.push(`Total entries: ${units.length}`);
	
	const counts = {
		user: units.filter(u => u.kind === "user").length,
		assistant: units.filter(u => u.kind === "assistant_text").length,
		tools: units.filter(u => u.kind === "assistant_tool").length,
		custom: units.filter(u => u.kind === "custom_message").length,
	};
	
	lines.push(`  • User messages: ${counts.user}`);
	lines.push(`  • Assistant responses: ${counts.assistant}`);
	lines.push(`  • Tool interactions: ${counts.tools}`);
	lines.push(`  • Custom messages: ${counts.custom}`);
	lines.push("");
	
	const totalTokens = units.reduce((sum, u) => sum + u.tokenEstimate, 0);
	lines.push(`Total tokens: ~${totalTokens}`);
	
	const marks = {
		selected: units.filter(u => state.marks[u.groupId]?.mark === "selected" || !state.marks[u.groupId]).length,
		unselected: units.filter(u => state.marks[u.groupId]?.mark === "unselected").length,
		compressed: units.filter(u => state.marks[u.groupId]?.compressedText).length,
		deleted: units.filter(u => state.marks[u.groupId]?.mark === "deleted").length,
	};
	
	lines.push("");
	lines.push("Selection status:");
	lines.push(`  • ${marks.selected} selected (visible to model)`);
	if (marks.unselected > 0) lines.push(`  • ${marks.unselected} unselected (hidden from model)`);
	if (marks.compressed > 0) lines.push(`  • ${marks.compressed} compressed`);
	if (marks.deleted > 0) lines.push(`  • ${marks.deleted} deleted`);
	
	lines.push("");
	lines.push("─".repeat(60));
	lines.push("  ENTRIES");
	lines.push("─".repeat(60));
	
	units.forEach((unit, idx) => {
		const mark = state.marks[unit.groupId]?.mark ?? "selected";
		const isCompressed = !!state.marks[unit.groupId]?.compressedText;
		const markSymbol = isCompressed ? "▤" : 
		                   mark === "selected" ? "●" :
		                   mark === "unselected" ? "○" :
		                   mark === "deleted" ? "✕" : "•";
		
		const markColor = isCompressed ? "[compressed]" :
		                 mark === "selected" ? "" :
		                 mark === "unselected" ? "[hidden]" :
		                 mark === "deleted" ? "[deleted]" : "";
		
		lines.push("");
		lines.push(`${idx + 1}. ${markSymbol} ${unit.metadata.heading} ${markColor}`);
		lines.push(`   Type: ${unit.kind}  •  ${unit.tokenEstimate} tokens  •  ${new Date(unit.timestamp).toLocaleTimeString()}`);
		
		if (showRetention && unit.metadata.retentionReason) {
			lines.push(`   Retention: ${unit.metadata.retentionReason}`);
		}
		
		if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
			const toolNames = unit.metadata.toolCalls.map(tc => tc.name).join(", ");
			lines.push(`   Tools: ${toolNames}`);
		}
		
		if (unit.metadata.keyFacts && unit.metadata.keyFacts.length > 0) {
			lines.push(`   Key facts: ${unit.metadata.keyFacts.slice(0, 3).join("; ")}${unit.metadata.keyFacts.length > 3 ? "..." : ""}`);
		}
	});
	
	lines.push("");
	lines.push("═".repeat(60));
	
	return lines.join("\n");
}

function formatDetailed(units: TurnUnit[], state: any, showRetention: boolean): string {
	const lines: string[] = [];
	
	lines.push("═".repeat(80));
	lines.push("  DETAILED CONTEXT OVERVIEW");
	lines.push("═".repeat(80));
	lines.push("");
	
	units.forEach((unit, idx) => {
		const mark = state.marks[unit.groupId]?.mark ?? "selected";
		const isCompressed = !!state.marks[unit.groupId]?.compressedText;
		
		lines.push("─".repeat(80));
		lines.push(`ENTRY ${idx + 1}`);
		lines.push("─".repeat(80));
		lines.push(`ID: ${unit.groupId}`);
		lines.push(`Type: ${unit.kind}`);
		lines.push(`Heading: ${unit.metadata.heading}`);
		lines.push(`Timestamp: ${unit.timestamp}`);
		lines.push(`Tokens: ${unit.tokenEstimate}`);
		lines.push(`Status: ${isCompressed ? "compressed" : mark}${isCompressed ? ` (${state.marks[unit.groupId]?.originalTokenEstimate} → ${state.marks[unit.groupId]?.compressedTokenEstimate} tokens)` : ""}`);
		lines.push(`Importance: ${unit.metadata.importanceScore}/100`);
		
		if (unit.metadata.retentionReason) {
			lines.push(`Retention reason: ${unit.metadata.retentionReason}`);
		}
		
		if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
			lines.push("");
			lines.push("Tool calls:");
			unit.metadata.toolCalls.forEach((tc, tIdx) => {
				lines.push(`  ${tIdx + 1}. ${tc.name}(${JSON.stringify(tc.arguments)})`);
				if (tc.result) {
					const resultPreview = tc.result.length > 100 ? tc.result.slice(0, 100) + "..." : tc.result;
					lines.push(`     Result: ${tc.description || resultPreview}`);
				}
			});
		}
		
		if (unit.metadata.keyFacts && unit.metadata.keyFacts.length > 0) {
			lines.push("");
			lines.push("Key facts:");
			unit.metadata.keyFacts.forEach(fact => {
				lines.push(`  • ${fact}`);
			});
		}
		
		if (showRetention) {
			lines.push("");
			lines.push("Retention analysis:");
			const analysis = generateRetentionAnalysis(unit);
			lines.push(`  ${analysis}`);
		}
		
		lines.push("");
		lines.push("Content preview:");
		const previewLines = unit.metadata.summary.split("\n").slice(0, 5);
		previewLines.forEach(line => {
			const truncated = line.length > 100 ? line.slice(0, 100) + "..." : line;
			lines.push(`  ${truncated}`);
		});
		if (unit.metadata.summary.split("\n").length > 5) {
			lines.push(`  ... (${unit.metadata.summary.split("\n").length - 5} more lines)`);
		}
		
		lines.push("");
	});
	
	lines.push("═".repeat(80));
	lines.push(`Total: ${units.length} entries, ~${units.reduce((sum, u) => sum + u.tokenEstimate, 0)} tokens`);
	lines.push("═".repeat(80));
	
	return lines.join("\n");
}

function formatLLMJSON(units: TurnUnit[], state: any): string {
	const entries = units.map(unit => {
		const entry = toLLMMemoryEntry(unit);
		const mark = state.marks[unit.groupId]?.mark ?? "selected";
		const isCompressed = !!state.marks[unit.groupId]?.compressedText;
		
		return {
			...entry,
			status: isCompressed ? "compressed" : mark,
			compression: isCompressed ? {
				originalTokens: state.marks[unit.groupId]?.originalTokenEstimate,
				compressedTokens: state.marks[unit.groupId]?.compressedTokenEstimate,
			} : undefined,
		};
	});
	
	return JSON.stringify({
		summary: {
			totalEntries: units.length,
			totalTokens: units.reduce((sum, u) => sum + u.tokenEstimate, 0),
			byType: {
				user: units.filter(u => u.kind === "user").length,
				assistant: units.filter(u => u.kind === "assistant_text").length,
				tools: units.filter(u => u.kind === "assistant_tool").length,
				custom: units.filter(u => u.kind === "custom_message").length,
			},
			byStatus: {
				selected: units.filter(u => state.marks[u.groupId]?.mark === "selected" || !state.marks[u.groupId]).length,
				unselected: units.filter(u => state.marks[u.groupId]?.mark === "unselected").length,
				compressed: units.filter(u => state.marks[u.groupId]?.compressedText).length,
				deleted: units.filter(u => state.marks[u.groupId]?.mark === "deleted").length,
			},
		},
		entries,
	}, null, 2);
}

function generateRetentionAnalysis(unit: TurnUnit): string {
	const parts: string[] = [];
	
	if (unit.kind === "user") {
		parts.push("User instruction or query");
	}
	
	if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
		const hasErrors = unit.metadata.toolCalls.some(tc => 
			tc.description?.includes("✗") || tc.description?.includes("error")
		);
		const hasFileOps = unit.metadata.toolCalls.some(tc => 
			tc.name === "read" || tc.name === "write" || tc.name === "edit"
		);
		
		if (hasErrors) {
			parts.push("Contains error information that may be needed for debugging");
		}
		if (hasFileOps) {
			parts.push("Contains file operations that document code changes");
		}
	}
	
	if (unit.metadata.keyFacts && unit.metadata.keyFacts.length > 0) {
		parts.push(`Contains ${unit.metadata.keyFacts.length} key factual elements`);
	}
	
	if (unit.metadata.importanceScore >= 80) {
		parts.push("High importance score suggests critical context");
	}
	
	return parts.length > 0 ? parts.join("; ") : "Standard conversation flow";
}

export function buildViewContextTool(): ToolDefinition<Record<string, unknown>, unknown> {
	return {
		name: "view_context",
		label: "View context overview",
		description:
			"Create a readable overview of your conversation context, similar to what the user sees in the /manage_context picker. " +
			"Shows all turn units with their metadata, token counts, importance scores, and current selection status. " +
			"Use this to understand what's in your context before deciding what to compress or unselect.",
		promptSnippet: "view_context — get a readable overview of your conversation context",
		parameters: {
			type: "object",
			properties: {
				format: {
					type: "string",
					enum: ["summary", "detailed", "llm-json"],
					description: "Output format: 'summary' (brief overview), 'detailed' (full metadata), or 'llm-json' (structured JSON). Defaults to 'summary'.",
				},
				includeDeleted: {
					type: "boolean",
					description: "If true, include entries marked as 'deleted'. Defaults to false.",
				},
				showRetention: {
					type: "boolean",
					description: "If true, show retention analysis for each entry. Only applies to 'detailed' format. Defaults to false.",
				},
			},
		},
		async execute(_toolCallId, params: Record<string, unknown>, _signal, _onUpdate, ctx: ExtensionContext) {
			const typedParams = params as ViewContextParams;
			const format = typedParams.format ?? "summary";
			const includeDeleted = typedParams.includeDeleted ?? false;
			const showRetention = typedParams.showRetention ?? false;
			
			const entries = ctx.sessionManager.buildContextEntries();
			const state = loadState(ctx);
			let units = buildTurnUnits(entries);
			
			// Filter out deleted entries unless explicitly requested
			if (!includeDeleted) {
				units = units.filter(u => state.marks[u.groupId]?.mark !== "deleted");
			}
			
			if (units.length === 0) {
				return {
					content: [{ type: "text", text: "No entries in context yet." }],
					details: { units: [], totalTokens: 0 },
				};
			}
			
			let output: string;
			switch (format) {
				case "detailed":
					output = formatDetailed(units, state, showRetention);
					break;
				case "llm-json":
					output = formatLLMJSON(units, state);
					break;
				case "summary":
				default:
					output = formatSummary(units, state, showRetention);
					break;
			}
			
			return {
				content: [{ type: "text", text: output }],
				details: {
					units: units.map(u => toLLMMemoryEntry(u)),
					totalTokens: units.reduce((sum, u) => sum + u.tokenEstimate, 0),
					totalEntries: units.length,
				},
			};
		},
	};
}