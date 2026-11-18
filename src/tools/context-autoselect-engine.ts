/**
 * context-autoselect's engine: spawn an in-process subagent that reviews every
 * turn unit and unselects the ones that are irrelevant or outdated for the
 * current task.
 *
 * The subagent runs via the SDK's createAgentSession() in the SAME process as
 * the parent session (a `pi --mode json` subprocess couldn't reach the
 * parent's tools or state). Its whole toolset is `customTools: [rate-context]`
 * with no extensions, skills, context files, or built-in tools loaded — so by
 * construction it can only ever rate entries and unselect the low-rated ones,
 * never select, compress, or delete. The child tool's execute() closes over
 * the PARENT's ExtensionAPI/ExtensionContext and mutates the parent session's
 * state directly; the "context" handler in src/hooks.ts applies the marks on
 * the parent's next model call. The subagent receives the manage-context TEXT
 * LIST of the context entries (formatAutoListingText) plus its instruction
 * (prompts/context-autoselect.md): call rate-context once with one
 * (ID, score 1-10, reason) tuple per entry; entries scored below the threshold
 * are unselected.
 *
 * Two halves, per the repo's pure-function + adapter split: buildAutoListing()
 * and summarizeAutoResult() are plain functions (unit-tested directly);
 * runAutoSelect() is the adapter, with the child-session creation behind an
 * injectable factory so integration tests can substitute a fake session
 * (same DI pattern as src/services/compression-service.ts).
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import { loadAutoSelectTemplate, renderAutoSelectTask } from "./autoselect-prompt.ts";
import type { ManageContextState } from "../state.ts";
import { oneLine, preserveLineBreaks, type TurnUnit } from "../turn-units.ts";
import { describeMark } from "../mark-status.ts";
import { buildChildRateContextTool } from "./rate-context.ts";

/** Cap for the one-line heading in the autoselect listing. */
export const AUTO_LISTING_HEADING_MAX = 80;
/** Cap for the (line-break-preserving) summary in the autoselect listing. */
export const AUTO_LISTING_SUMMARY_MAX = 1000;

/** One compact row of the listing offered to the subagent. */
export interface AutoListingRow {
	groupId: string;
	heading: string;
	type: string;
	tokenEstimate: number;
	summary: string;
	mark: string;
}

export interface AutoSelectParams {
	focus?: string;
	dryRun?: boolean;
}

export interface AutoSelectResult {
	content: [{ type: "text"; text: string }];
	details: { unselected: string[]; dryRun: boolean };
}

/**
 * Compact rows for the subagent prompt. The latest user unit is excluded —
 * it is the turn the agent is currently answering, never a candidate for
 * unselection.
 */
export function buildAutoListing(units: TurnUnit[], state: ManageContextState): AutoListingRow[] {
	let lastUserIndex = -1;
	units.forEach((unit, index) => {
		if (unit.kind === "user") lastUserIndex = index;
	});
	return units
		.filter((_, index) => index !== lastUserIndex)
		.map((unit) => ({
			groupId: unit.groupId,
			heading: oneLine(unit.metadata.heading, AUTO_LISTING_HEADING_MAX),
			type: unit.metadata.type,
			tokenEstimate: unit.tokenEstimate,
			summary: preserveLineBreaks(unit.metadata.summary, AUTO_LISTING_SUMMARY_MAX),
			mark: describeMark(unit, state).effective,
		}));
}

/**
 * The task prompt handed to the subagent: the instruction template (see
 * src/tools/autoselect-prompt.ts — editable via prompts/context-autoselect.md
 * or a per-project .pi/context-autoselect.md) with the context TEXT LIST and
 * the focus filled in.
 */
export function buildAutoSelectTask(listing: AutoListingRow[], focus: string | undefined, template: string): string {
	return renderAutoSelectTask(template, listing, focus);
}

/** Tool-result text for the parent model summarizing what the subagent did. */
export function summarizeAutoResult(details: { unselected: string[]; dryRun: boolean }): string {
	const suffix = details.dryRun ? " (dry run — nothing was persisted)" : "";
	if (details.unselected.length === 0) {
		return `context-autoselect${suffix}: the subagent found no units to unselect.`;
	}
	const lines = [`context-autoselect${suffix}: unselected ${details.unselected.length} unit(s):`];
	for (const id of details.unselected) lines.push(`  ${id}`);
	return lines.join("\n");
}

/**
 * The part of a real AgentSession the engine needs. Typed against the real SDK
 * type (not a structural duck type) so the turn-cap check below is
 * compile-time safe and can't silently stop matching if event shapes drift.
 */
export type AutoSelectChildSession = Pick<AgentSession, "prompt" | "abort" | "dispose" | "subscribe">;

export interface AutoSelectChildOptions {
	model: Model<any> | undefined;
	customTools: ToolDefinition[];
	sessionManager: SessionManager;
	cwd: string;
}

/** Injectable so tests can substitute a fake child session (and do zero real I/O). */
export type AutoSelectSessionFactory = (options: AutoSelectChildOptions) => Promise<AutoSelectChildSession>;

/** The real child session: in-process, inheriting the parent's model, with rate-context as its only tool. */
export const defaultAutoSelectSessionFactory: AutoSelectSessionFactory = async (options) => {
	// The resource loader is built HERE, inside the factory seam, so a fake
	// factory in tests never touches the real ~/.pi/agent directory.
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		model: options.model,
		customTools: options.customTools,
		sessionManager: options.sessionManager,
		resourceLoader,
		noTools: "all",
	});
	return session;
};

/** Cap on child turns so a looping model can't spin forever. */
export const MAX_CHILD_TURNS = 5;

/** Run the child session: prompt it, cap its turns, propagate the parent's abort signal, always dispose. */
async function runChildSession(session: AutoSelectChildSession, task: string, signal: AbortSignal | undefined): Promise<void> {
	let assistantTurns = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			assistantTurns += 1;
			if (assistantTurns >= MAX_CHILD_TURNS) session.abort();
		}
	});
	const onAbort = () => session.abort();
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		await session.prompt(task);
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}
}

/**
 * Orchestration: build the listing, spawn the child subagent via the
 * (injectable) session factory, run it, and summarize the outcome. Under
 * dryRun the child's context-unselect calls are recorded but never persisted.
 */
export async function runAutoSelect(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	units: TurnUnit[],
	state: ManageContextState,
	params: AutoSelectParams,
	signal: AbortSignal | undefined,
	sessionFactory: AutoSelectSessionFactory = defaultAutoSelectSessionFactory,
): Promise<AutoSelectResult> {
	const dryRun = params.dryRun ?? false;
	const listing = buildAutoListing(units, state);
	if (listing.length === 0) {
		const details = { unselected: [] as string[], dryRun };
		return {
			content: [{ type: "text", text: "context-autoselect: no turn units available to review — only the latest user turn exists, and it is never a candidate." }],
			details,
		};
	}

	const unselected: string[] = [];
	const session = await sessionFactory({
		model: ctx.model,
		customTools: [buildChildRateContextTool(pi, ctx, units, dryRun, unselected)] as ToolDefinition[],
		sessionManager: SessionManager.inMemory(),
		cwd: ctx.cwd,
	});
	const template = await loadAutoSelectTemplate(ctx.cwd);
	await runChildSession(session, buildAutoSelectTask(listing, params.focus, template), signal);

	const details = { unselected, dryRun };
	return { content: [{ type: "text", text: summarizeAutoResult(details) }], details };
}
