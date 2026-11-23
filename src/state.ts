/**
 * Persisted state for manage-context: the configured compression model and
 * the per-turn-unit marks (selected / unselected / compressed / deleted).
 *
 * State lives in a "custom" session entry (customType: STATE_CUSTOM_TYPE)
 * appended via pi.appendEntry(). loadState() scans backward and returns the
 * most recently appended one, so each save is a full snapshot.
 *
 * All mutation goes through updateState(), which loads, applies the mutator,
 * prunes marks for entries that no longer exist in the session (GC — without
 * it, orphaned marks for compacted-away entries persist in every snapshot
 * forever), migrates older versions, and appends the new snapshot in one
 * place — callers can't load-modify-save out of sync.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Mark = "selected" | "unselected" | "compressed" | "deleted";

export interface MarkInfo {
	mark: Mark;
	/** Populated once a "compressed" mark has actually been realized. */
	compressedText?: string;
	compressedAt?: string;
	originalTokenEstimate?: number;
	compressedTokenEstimate?: number;
}

/** Which message category a context window limits. */
export type WindowMode = "tool" | "assistant" | "user";

/**
 * Context-window limit: when `mode` is set, only the latest `window` turn
 * units per message kind inside that mode's category stay visible to the
 * model (tool = tool-call units; assistant = assistant messages + tool
 * calls; user = all of those + user messages). null mode/window = no window
 * filtering. Window exclusions are ephemeral — they are never written into
 * `marks`; manual marks always win (see context-filter.ts).
 */
export interface WindowConfig {
	mode: WindowMode | null;
	window: number | null;
}

export interface ManageContextState {
	version: 3;
	/** provider/id of the model used for compression. Falls back to ctx.model when unset. */
	compressionModel?: { provider: string; id: string };
	/** keyed by TurnUnit.groupId */
	marks: Record<string, MarkInfo>;
	/** Switch checked by the read tool's "tool_result" hook. Toggled via /toggle-read-hook. */
	readHookEnabled: boolean;
	/** /mc config override; when present it fully replaces the settings.json window default. */
	windowConfig?: WindowConfig;
}

export const STATE_CUSTOM_TYPE = "manage-context";

export function emptyState(): ManageContextState {
	return { version: 3, marks: {}, readHookEnabled: false };
}

/**
 * Migrate a stored snapshot to the current version. Unknown/future versions
 * are discarded (start fresh) rather than partially applied — a state shape
 * we don't understand may have marks keyed differently, and silently
 * misapplying those would hide or show the wrong context.
 */
function migrate(raw: unknown): ManageContextState | null {
	if (!raw || typeof raw !== "object") return null;
	const data = raw as Record<string, unknown>;

	if (data.version === 3) return data as unknown as ManageContextState;

	if (data.version === 2 || data.version === 1) {
		// v1/v2 → v3: same mark shape, only the version constant changed (v3
		// adds the optional windowConfig, which old snapshots simply lack).
		const state = data as unknown as Omit<ManageContextState, "version"> & { version: number };
		return { ...state, version: 3 };
	}

	return null;
}

export function loadState(ctx: Pick<ExtensionContext, "sessionManager">): ManageContextState {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "custom" && e.customType === STATE_CUSTOM_TYPE) {
			const migrated = migrate(e.data);
			if (migrated) return migrated;
		}
	}
	return emptyState();
}

/** True if `state` has no persisted marks — callers can skip filtering work entirely. */
export function hasMarks(state: ManageContextState): boolean {
	return Object.keys(state.marks).length > 0;
}

/**
 * Drop marks whose groupId no longer corresponds to a live session entry.
 * Called on every updateState() so snapshots don't accumulate orphans.
 */
export function pruneMarks(state: ManageContextState, liveGroupIds: Set<string>): number {
	const before = Object.keys(state.marks).length;
	for (const groupId of Object.keys(state.marks)) {
		if (!liveGroupIds.has(groupId)) delete state.marks[groupId];
	}
	return before - Object.keys(state.marks).length;
}

export function saveState(pi: ExtensionAPI, state: ManageContextState): void {
	pi.appendEntry(STATE_CUSTOM_TYPE, state);
}
