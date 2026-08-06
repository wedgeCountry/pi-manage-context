/**
 * Persisted state for manage-context: the configured compression model and
 * the per-turn-unit marks (selected / unselected / compressed / deleted).
 *
 * State lives in a "custom" session entry (customType: STATE_CUSTOM_TYPE)
 * appended via pi.appendEntry(). loadState() scans backward and returns the
 * most recently appended one, so each save is a full snapshot.
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
	version: 1;
	/** provider/id of the model used for compression. Falls back to ctx.model when unset. */
	compressionModel?: { provider: string; id: string };
	/** keyed by TurnUnit.groupId */
	marks: Record<string, MarkInfo>;
	/** Switch checked by the read tool's "tool_result" hook. Toggled via /toggle-read-hook. */
	readHookEnabled: boolean;
}

export const STATE_CUSTOM_TYPE = "manage-context";

export function emptyState(): ManageContextState {
	return { version: 1, marks: {}, readHookEnabled: false };
}

export function loadState(ctx: Pick<ExtensionContext, "sessionManager">): ManageContextState {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "custom" && e.customType === STATE_CUSTOM_TYPE) {
			const data = e.data as ManageContextState | undefined;
			if (data && data.version === 1) return data;
		}
	}
	return emptyState();
}

export function saveState(pi: ExtensionAPI, state: ManageContextState): void {
	pi.appendEntry(STATE_CUSTOM_TYPE, state);
}
