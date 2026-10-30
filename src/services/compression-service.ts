/**
 * Compression service for the picker: owns the AbortController and resolves
 * the compression model, so the view-model just awaits `compress(unit)` and
 * can `cancel()` without knowing anything about LLM calls or models.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { compressUnit, resolveCompressionModel } from "../compression.ts";
import type { ManageContextState } from "../state.ts";
import type { TurnUnit } from "../turn-units.ts";

export interface CompressionService {
	compress(unit: TurnUnit): Promise<string>;
	cancel(): void;
}

export function createCompressionService(ctx: ExtensionContext, state: ManageContextState): CompressionService {
	const abortController = new AbortController();
	return {
		compress: async (unit) => {
			const model = await resolveCompressionModel(ctx, state);
			if (!model) throw new Error("no model available");
			return compressUnit(unit, model, ctx, abortController.signal);
		},
		cancel: () => abortController.abort(),
	};
}
