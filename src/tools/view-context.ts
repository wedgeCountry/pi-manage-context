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
import { describeMark } from "../mark-status.ts";

export function formatSummary(units: TurnUnit[], state: ManageContextState): string {
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
		selected: units.filter((u) => describeMark(u, state).effective === "selected").length,
		unselected: units.filter((u) => describeMark(u, state).effective === "unselected").length,
		compressed: units.filter((u) => describeMark(u, state).effective === "compressed").length,
		deleted: units.filter((u) => describeMark(u, state).effective === "deleted").length,
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
		const { symbol, label } = describeMark(unit, state);

		lines.push("");
		lines.push(`${idx + 1}. ${symbol} ${unit.metadata.heading}${label ? ` ${label}` : ""}`);
		lines.push(`   Type: ${unit.kind}  •  ${unit.tokenEstimate} tokens  •  ${new Date(unit.timestamp).toLocaleTimeString()}`);

		if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
			const toolNames = unit.metadata.toolCalls.map((tc) => tc.name).join(", ");
			lines.push(`   Tools: ${toolNames}`);
		}
	});

	lines.push("");
	lines.push("═".repeat(60));

	return lines.join("\n");
}

export function formatDetailed(units: TurnUnit[], state: ManageContextState): string {
	const lines: string[] = [];

	lines.push("═".repeat(80));
	lines.push("  DETAILED CONTEXT OVERVIEW");
	lines.push("═".repeat(80));
	lines.push("");

	units.forEach((unit, idx) => {
		const { effective, info } = describeMark(unit, state);

		lines.push("─".repeat(80));
		lines.push(`ENTRY ${idx + 1}`);
		lines.push("─".repeat(80));
		lines.push(`ID: ${unit.groupId}`);
		lines.push(`Type: ${unit.kind}`);
		lines.push(`Heading: ${unit.metadata.heading}`);
		lines.push(`Timestamp: ${unit.timestamp}`);
		lines.push(`Tokens: ${unit.tokenEstimate}`);
		lines.push(
			`Status: ${effective}${info?.compressedText ? ` (${info.originalTokenEstimate} → ${info.compressedTokenEstimate} tokens)` : ""}`,
		);

		if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
			lines.push("");
			lines.push("Tool calls:");
			unit.metadata.toolCalls.forEach((tc, tIdx) => {
				lines.push(`  ${tIdx + 1}. ${tc.name}(${JSON.stringify(tc.arguments)})`);
				if (tc.result) {
					const resultPreview = tc.result.length > 100 ? `${tc.result.slice(0, 100)}...` : tc.result;
					lines.push(`     Result: ${tc.description || resultPreview}`);
				}
			});
		}

		lines.push("");
		lines.push("Content preview:");
		const previewLines = unit.metadata.summary.split("\n").slice(0, 5);
		previewLines.forEach((line) => {
			const truncated = line.length > 100 ? `${line.slice(0, 100)}...` : line;
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
		const { effective, info } = describeMark(unit, state);

		return {
			...entry,
			status: effective,
			compression: info?.compressedText
				? {
						originalTokens: info.originalTokenEstimate,
						compressedTokens: info.compressedTokenEstimate,
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
					selected: entries.filter((e) => e.status === "selected").length,
					unselected: entries.filter((e) => e.status === "unselected").length,
					compressed: entries.filter((e) => e.status === "compressed").length,
					deleted: entries.filter((e) => e.status === "deleted").length,
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

	let text: string;
	switch (format) {
		case "detailed":
			text = formatDetailed(units, state);
			break;
		case "llm-json":
			text = formatLLMJSON(units, state);
			break;
		case "summary":
		default:
			text = formatSummary(units, state);
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
				units = units.filter((u) => describeMark(u, state).effective !== "deleted");
			}

			const { text, details } = buildContextOverview(units, state, params);
			return { content: [{ type: "text", text }], details };
		},
	};
}

export function registerViewContextTool(pi: ExtensionAPI): void {
	pi.registerTool(buildViewContextTool());
}
