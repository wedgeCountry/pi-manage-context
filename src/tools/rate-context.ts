/**
 * rate-context — the context-autoselect subagent's ONLY tool: it rates every
 * context entry with a tuple of (ID, score 1-10, short reason), writes an
 * export file of the ratings to the working directory, and unselects every
 * entry whose score is below the given threshold.
 *
 * The score semantics come from the subagent's instruction
 * (prompts/context-autoselect.md): 1 = small importance, 10 = very high
 * importance for future sessions, measured by usefulness and relevance —
 * outdated information has low relevance.
 *
 * Two halves, per the repo's pure-function + adapter split: runRateContext()
 * is a plain, ExtensionContext-free function (unit-tested directly) that
 * mutates state.marks in place and builds the export markdown;
 * buildChildRateContextTool() is the adapter whose execute() closes over the
 * PARENT's pi/ctx (the subagent runs in-process), writes the export file,
 * and persists the marks via saveState() unless dryRun.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { RATE_CONTEXT_TOOL_DEFINITION, type RateContextParams } from "../tool_definitions/rate-context.ts";
import { loadState, saveState, type ManageContextState } from "../state.ts";
import { oneLine, type TurnUnit } from "../turn-units.ts";
import { createTool } from "./createTool.ts";
import { runContextMark } from "./context-mark.ts";

/** Score range, per the subagent instruction: 1 = small, 10 = very high importance. */
export const MIN_SCORE = 1;
export const MAX_SCORE = 10;

/** Default threshold: entries scored below this are unselected. */
export const DEFAULT_RATE_THRESHOLD = 5;

/** One rating tuple for one context entry: (ID, score, reason). */
export interface ContextRating {
	id: string;
	score: number;
	reason: string;
}

export interface RateContextDetails {
	threshold: number;
	ratings: ContextRating[];
	/** groupIds actually marked unselected (rated below threshold and matched). */
	unselected: string[];
	/** Rated ids that matched no turn unit (never applied). */
	notMatched: string[];
	/** Ratings with an out-of-range or non-numeric score — ignored. */
	invalid: ContextRating[];
	/** Markdown export of the input; the adapter writes this to a file. */
	exportMarkdown: string;
	/** Path of the written export file (set by the adapter). */
	exportedFile?: string;
}

export interface RateContextResult {
	content: [{ type: "text"; text: string }];
	details: RateContextDetails;
	/** Whether state.marks was mutated and needs to be persisted via saveState(). */
	changed: boolean;
}

/** A rating is applicable only with a numeric score inside [1, 10]. */
export function isValidRating(rating: ContextRating): boolean {
	return typeof rating.score === "number" && Number.isFinite(rating.score) && rating.score >= MIN_SCORE && rating.score <= MAX_SCORE;
}

function resolveThreshold(threshold: number | undefined): number {
	if (threshold === undefined || !Number.isFinite(threshold)) return DEFAULT_RATE_THRESHOLD;
	return Math.min(MAX_SCORE, Math.max(0, threshold));
}

/** Default export filename, timestamped like /export_context's default. */
export function rateContextExportFilename(now: Date = new Date()): string {
	return `context-ratings-${now.toISOString().replace(/[:.]/g, "-")}.md`;
}

/** Markdown export of the tool's input (the ratings + threshold). */
export function formatRatingsExport(ratings: ContextRating[], threshold: number): string {
	const lines: string[] = [];
	lines.push("# Context Ratings Export");
	lines.push("");
	lines.push(`**Exported**: ${new Date().toISOString()}`);
	lines.push(`**Tool**: ${RATE_CONTEXT_TOOL_DEFINITION.name}`);
	lines.push(`**Threshold**: ${threshold} (entries scored below are unselected)`);
	lines.push(`**Ratings**: ${ratings.length}`);
	lines.push("");
	lines.push("| ID | Score | Reason |");
	lines.push("|---|---|---|");
	for (const rating of ratings) {
		lines.push(`| ${rating.id} | ${rating.score} | ${oneLine(String(rating.reason ?? ""), 200).replace(/\|/g, "\\|")} |`);
	}
	lines.push("");
	return lines.join("\n");
}

/** Write the ratings export file into `cwd`; returns the full path. */
export async function writeRatingsExport(cwd: string, markdown: string): Promise<string> {
	const targetPath = resolve(cwd, rateContextExportFilename());
	await writeFile(targetPath, markdown, "utf-8");
	return targetPath;
}

/**
 * Plain function: no ExtensionAPI/ExtensionContext involved. Takes the turn
 * units and persisted state the caller already fetched, marks every entry
 * rated below the threshold as unselected (via runContextMark, so unknown ids
 * are reported, never silently applied), and builds the tool result plus the
 * export markdown of the input.
 */
export function runRateContext(units: TurnUnit[], state: ManageContextState, params: RateContextParams): RateContextResult {
	const threshold = resolveThreshold(params.threshold);
	const ratings = params.ratings ?? [];
	const valid = ratings.filter(isValidRating);
	const invalid = ratings.filter((r) => !isValidRating(r));

	const belowThreshold = valid.filter((r) => r.score < threshold).map((r) => r.id);
	const markResult = runContextMark(units, state, belowThreshold, "unselect", RATE_CONTEXT_TOOL_DEFINITION.name);

	const knownIds = new Set(units.map((u) => u.groupId));
	const notMatched = valid.map((r) => r.id).filter((id) => !knownIds.has(id));

	const lines: string[] = [];
	lines.push(
		`${RATE_CONTEXT_TOOL_DEFINITION.name}: rated ${ratings.length} entr${ratings.length === 1 ? "y" : "ies"} with threshold ${threshold}.`,
	);
	if (belowThreshold.length === 0) {
		lines.push("No entry scored below the threshold — nothing unselected.");
	} else {
		lines.push(`Entries scored below ${threshold}: ${belowThreshold.join(", ")}`);
		lines.push(markResult.content[0].text);
	}
	if (invalid.length > 0) {
		lines.push(`Ignored ${invalid.length} rating(s) with a score outside 1-10: ${invalid.map((r) => `${r.id} (${r.score})`).join(", ")}`);
	}
	if (notMatched.length > 0) {
		lines.push(`Not matched (unknown ids): ${notMatched.join(", ")}`);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			threshold,
			ratings,
			unselected: markResult.details,
			notMatched,
			invalid,
			exportMarkdown: formatRatingsExport(ratings, threshold),
		},
		changed: markResult.changed,
	};
}

/**
 * The subagent's only tool: the real rate-context definition whose execute
 * closes over the PARENT's pi and ctx (the whole point of the in-process
 * subagent). State is re-loaded per call (not captured) so a multi-second
 * subagent run never mutates a stale snapshot. The ratings export file is
 * always written (it is the export of the tool's input); marks are persisted
 * only when not dryRun.
 */
export function buildChildRateContextTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	units: TurnUnit[],
	dryRun: boolean,
	unselected: string[],
): ToolDefinition<typeof RATE_CONTEXT_TOOL_DEFINITION.parameters, RateContextDetails> {
	// The hooks deliberately ignore the child's own env.ctx and close over the
	// PARENT's ctx instead — the whole point of the in-process subagent.
	return createTool<typeof RATE_CONTEXT_TOOL_DEFINITION.parameters, RateContextDetails>(RATE_CONTEXT_TOOL_DEFINITION, {
		execute: async (childParams: RateContextParams) => {
			const state = loadState(ctx);
			const result = runRateContext(units, state, childParams);
			const exportedFile = await writeRatingsExport(ctx.cwd, result.details.exportMarkdown);
			if (result.changed) {
				unselected.push(...result.details.unselected);
				if (!dryRun) saveState(pi, state);
			}
			const text = `${result.content[0].text}\nRatings export written to ${exportedFile}`;
			return {
				content: [{ type: "text", text }],
				details: { ...result.details, exportedFile },
			};
		},
	});
}
