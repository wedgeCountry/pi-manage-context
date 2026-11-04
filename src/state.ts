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

export interface ManageContextState {
	version: 2;
	/** provider/id of the model used for compression. Falls back to ctx.model when unset. */
	compressionModel?: { provider: string; id: string };
	/** keyed by TurnUnit.groupId */
	marks: Record<string, MarkInfo>;
	/** Switch checked by the read tool's "tool_result" hook. Toggled via /toggle-read-hook. */
	readHookEnabled: boolean;
}

export const STATE_CUSTOM_TYPE = "manage-context";

export function emptyState(): ManageContextState {
	return { version: 2, marks: {}, readHookEnabled: false };
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

	if (data.version === 2) return data as unknown as ManageContextState;

	if (data.version === 1) {
		// v1 → v2: same mark shape, only the version constant changed.
		const state = data as unknown as Omit<ManageContextState, "version"> & { version: 1 };
		return { ...state, version: 2 };
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

/**
 * The single load→mutate→save entry point for extension code: resolves the
 * session entries, prunes dead marks, applies the mutator to the fresh
 * state, and persists the snapshot. Returns the persisted state.
 *
 * Callers that only need the current state (read-only) use loadState().
 */
export function updateState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mutate: (state: ManageContextState) => void,
): ManageContextState {
	const state = loadState(ctx);
	mutate(state);
	saveState(pi, state);
	return state;
}
