/**
 * view_context — provides the AI agent with a readable overview of its
 * conversation context, similar to what the user sees in the /manage_context
 * picker UI. Returns a formatted list of all turn units with their metadata,
 * making it easy for the model to understand what's in context without
 * needing to parse raw messages.
 *
 * Unlike manage-context (which is for programmatic select/unselect
 * operations), this tool is designed for human-readable inspection and
 * awareness of the current context state.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { VIEW_CONTEXT_TOOL_DEFINITION, type ViewContextParams } from "../tool_definitions/view-context.ts";
import { loadState, type ManageContextState } from "../state.ts";
import { buildTurnUnits, type TurnUnit } from "../turn-units.ts";
import { toLLMMemoryEntry } from "../llm-export.ts";

export function formatSummary(units: TurnUnit[], state: ManageContextState, showRetention: boolean): string {
	const lines: string[] = [];

	lines.push("═".repeat(60));
	lines.push("  CONTEXT OVERVIEW");
	lines.push("═".repeat(60));
	lines.push("");
	lines.push(`Total entries: ${units.length}`);

	const counts = {
		user: units.filter((u) => u.kind === "user").length,
		assistant: units.filter((u) => u.kind === "assistant_text").length,
		tools: units.filter((u) => u.kind === "assistant_tool").length,
		custom: units.filter((u) => u.kind === "custom_message").length,
	};

	lines.push(`  • User messages: ${counts.user}`);
	lines.push(`  • Assistant responses: ${counts.assistant}`);
	lines.push(`  • Tool interactions: ${counts.tools}`);
	lines.push(`  • Custom messages: ${counts.custom}`);
	lines.push("");

	const totalTokens = units.reduce((sum, u) => sum + u.tokenEstimate, 0);
	lines.push(`Total tokens: ~${totalTokens}`);

	const marks = {
		selected: units.filter((u) => state.marks[u.groupId]?.mark === "selected" || !state.marks[u.groupId]).length,
		unselected: units.filter((u) => state.marks[u.groupId]?.mark === "unselected").length,
		compressed: units.filter((u) => state.marks[u.groupId]?.compressedText).length,
		deleted: units.filter((u) => state.marks[u.groupId]?.mark === "deleted").length,
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
		const markSymbol = isCompressed
			? "▤"
			: mark === "selected"
				? "●"
				: mark === "unselected"
					? "○"
					: mark === "deleted"
						? "✕"
						: "•";

		const markColor = isCompressed ? "[compressed]" : mark === "selected" ? "" : mark === "unselected" ? "[hidden]" : mark === "deleted" ? "[deleted]" : "";

		lines.push("");
		lines.push(`${idx + 1}. ${markSymbol} ${unit.metadata.heading} ${markColor}`);
		lines.push(`   Type: ${unit.kind}  •  ${unit.tokenEstimate} tokens  •  ${new Date(unit.timestamp).toLocaleTimeString()}`);

		if (showRetention && unit.metadata.retentionReason) {
			lines.push(`   Retention: ${unit.metadata.retentionReason}`);
		}

		if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
			const toolNames = unit.metadata.toolCalls.map((tc) => tc.name).join(", ");
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

export function generateRetentionAnalysis(unit: TurnUnit): string {
	const parts: string[] = [];

	if (unit.kind === "user") {
		parts.push("User instruction or query");
	}

	if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
		const hasErrors = unit.metadata.toolCalls.some((tc) => tc.description?.includes("✗") || tc.description?.includes("error"));
		const hasFileOps = unit.metadata.toolCalls.some((tc) => tc.name === "read" || tc.name === "write" || tc.name === "edit");

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

export function formatDetailed(units: TurnUnit[], state: ManageContextState, showRetention: boolean): string {
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
			unit.metadata.keyFacts.forEach((fact) => {
				lines.push(`  • ${fact}`);
			});
		}

		if (showRetention) {
			lines.push("");
			lines.push("Retention analysis:");
			lines.push(`  ${generateRetentionAnalysis(unit)}`);
		}

		lines.push("");
		lines.push("Content preview:");
		const previewLines = unit.metadata.summary.split("\n").slice(0, 5);
		previewLines.forEach((line) => {
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

export function formatLLMJSON(units: TurnUnit[], state: ManageContextState): string {
	const entries = units.map((unit) => {
		const entry = toLLMMemoryEntry(unit);
		const mark = state.marks[unit.groupId]?.mark ?? "selected";
		const isCompressed = !!state.marks[unit.groupId]?.compressedText;

		return {
			...entry,
			status: isCompressed ? "compressed" : mark,
			compression: isCompressed
				? {
						originalTokens: state.marks[unit.groupId]?.originalTokenEstimate,
						compressedTokens: state.marks[unit.groupId]?.compressedTokenEstimate,
					}
				: undefined,
		};
	});

	return JSON.stringify(
		{
			summary: {
				totalEntries: units.length,
				totalTokens: units.reduce((sum, u) => sum + u.tokenEstimate, 0),
				byType: {
					user: units.filter((u) => u.kind === "user").length,
					assistant: units.filter((u) => u.kind === "assistant_text").length,
					tools: units.filter((u) => u.kind === "assistant_tool").length,
					custom: units.filter((u) => u.kind === "custom_message").length,
				},
				byStatus: {
					selected: units.filter((u) => state.marks[u.groupId]?.mark === "selected" || !state.marks[u.groupId]).length,
					unselected: units.filter((u) => state.marks[u.groupId]?.mark === "unselected").length,
					compressed: units.filter((u) => state.marks[u.groupId]?.compressedText).length,
					deleted: units.filter((u) => state.marks[u.groupId]?.mark === "deleted").length,
				},
			},
			entries,
		},
		null,
		2,
	);
}

export interface ViewContextResult {
	text: string;
	details: { units: ReturnType<typeof toLLMMemoryEntry>[]; totalTokens: number; totalEntries?: number };
}

/**
 * Plain function: no ExtensionAPI/ExtensionContext involved. Takes the turn
 * units the caller already fetched (filtered for includeDeleted) and the
 * persisted state, and renders the requested format.
 */
export function buildContextOverview(units: TurnUnit[], state: ManageContextState, params: ViewContextParams): ViewContextResult {
	if (units.length === 0) {
		return { text: "No entries in context yet.", details: { units: [], totalTokens: 0 } };
	}

	const format = params.format ?? "summary";
	const showRetention = params.showRetention ?? false;

	let text: string;
	switch (format) {
		case "detailed":
			text = formatDetailed(units, state, showRetention);
			break;
		case "llm-json":
			text = formatLLMJSON(units, state);
			break;
		case "summary":
		default:
			text = formatSummary(units, state, showRetention);
			break;
	}

	return {
		text,
		details: {
			units: units.map((u) => toLLMMemoryEntry(u)),
			totalTokens: units.reduce((sum, u) => sum + u.tokenEstimate, 0),
			totalEntries: units.length,
		},
	};
}

export function buildViewContextTool(): ToolDefinition<typeof VIEW_CONTEXT_TOOL_DEFINITION.parameters, unknown> {
	return {
		...VIEW_CONTEXT_TOOL_DEFINITION,
		async execute(_toolCallId, params: ViewContextParams, _signal, _onUpdate, ctx: ExtensionContext) {
			const includeDeleted = params.includeDeleted ?? false;

			const entries = ctx.sessionManager.buildContextEntries();
			const state = loadState(ctx);
			let units = buildTurnUnits(entries);
			if (!includeDeleted) {
				units = units.filter((u) => state.marks[u.groupId]?.mark !== "deleted");
			}

			const { text, details } = buildContextOverview(units, state, params);
			return { content: [{ type: "text", text }], details };
		},
	};
}

export function registerViewContextTool(pi: ExtensionAPI): void {
	pi.registerTool(buildViewContextTool());
}
