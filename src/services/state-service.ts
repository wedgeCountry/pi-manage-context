/**
 * Persistence service for the picker: the view-model's only way to read or
 * write ManageContextState, so state access (load/save against the session)
 * stays out of the view and is swappable in tests.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadState, saveState, type ManageContextState } from "../state.ts";

export interface StateService {
	load(): ManageContextState;
	save(state: ManageContextState): void;
}

export function createStateService(pi: ExtensionAPI, ctx: ExtensionContext): StateService {
	return {
		load: () => loadState(ctx),
		save: (state) => saveState(pi, state),
	};
}
