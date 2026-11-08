/**
 * context-autoselect's engine: spawn an in-process subagent that reviews every
 * turn unit and unselects the ones that are irrelevant or outdated for the
 * current task.
 *
 * The subagent runs via the SDK's createAgentSession() in the SAME process as
 * the parent session (a `pi --mode json` subprocess couldn't reach the
 * parent's tools or state). Its whole toolset is `customTools:
 * [context-unselect]` with no extensions, skills, context files, or built-in
 * tools loaded — so by construction it can only ever unselect, never select,
 * compress, or delete. The child tool's execute() closes over the PARENT's
 * ExtensionAPI/ExtensionContext and mutates the parent session's state
 * directly; the "context" handler in src/hooks.ts applies the marks on the
 * parent's next model call.
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

import { CONTEXT_UNSELECT_TOOL_DEFINITION, type ContextUnselectParams } from "../tool_definitions/context-unselect.ts";
import { saveState, type ManageContextState } from "../state.ts";
import { oneLine, preserveLineBreaks, type TurnUnit } from "../turn-units.ts";
import { describeMark } from "../mark-status.ts";
import { runContextMark } from "./context-mark.ts";

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
			heading: oneLine(unit.metadata.heading, 80),
			type: unit.metadata.type,
			tokenEstimate: unit.tokenEstimate,
			summary: preserveLineBreaks(unit.metadata.summary, 1000),
			mark: describeMark(unit, state).effective,
		}));
}

/** The task prompt handed to the subagent: listing as JSON plus the focus. */
export function buildAutoSelectTask(listing: AutoListingRow[], focus?: string): string {
	return [
		"You are reviewing the turn units of a conversation to decide which are irrelevant or outdated for the current task.",
		focus ? `Current task: ${focus}` : "Current task: (not specified — judge relevance to the conversation as a whole)",
		"",
		"Turn units (JSON; groupId is the identifier, mark is the current state):",
		JSON.stringify(listing, null, 2),
		"",
		"Instructions:",
		'- Call context-unselect ONCE with the groupIds of the units that are irrelevant or outdated for the current task.',
		"- Be conservative: when in doubt, keep the unit selected.",
		"- The latest user turn is not in this list; do not reference it.",
		"- If nothing should be unselected, call context-unselect with an empty groupIds array.",
	].join("\n");
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

/** The real child session: in-process, inheriting the parent's model, with context-unselect as its only tool. */
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

/**
 * The child's only tool: the real context-unselect definition whose execute
 * closes over the PARENT's pi and state. runContextMark already rejects
 * unknown groupIds, so the subagent can't invent ids.
 */
export function buildChildUnselectTool(
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
	units: TurnUnit[],
	state: ManageContextState,
	dryRun: boolean,
	unselected: string[],
): ToolDefinition<typeof CONTEXT_UNSELECT_TOOL_DEFINITION.parameters, unknown> {
	return {
		...CONTEXT_UNSELECT_TOOL_DEFINITION,
		async execute(_toolCallId, childParams: ContextUnselectParams) {
			const result = runContextMark(units, state, childParams.groupIds, "unselect", CONTEXT_UNSELECT_TOOL_DEFINITION.name);
			if (result.changed) {
				unselected.push(...result.details);
				if (!dryRun) saveState(pi, state);
			}
			return { content: result.content, details: result.details };
		},
	};
}

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
		customTools: [buildChildUnselectTool(pi, ctx, units, state, dryRun, unselected)],
		sessionManager: SessionManager.inMemory(),
		cwd: ctx.cwd,
	});
	await runChildSession(session, buildAutoSelectTask(listing, params.focus), signal);

	const details = { unselected, dryRun };
	return { content: [{ type: "text", text: summarizeAutoResult(details) }], details };
}
