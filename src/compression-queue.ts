/**
 * Compression orchestration for the picker's "processing" phase, extracted
 * from ManageContextView so the queue logic (sequential execution, progress
 * accounting, mark resolution, error/cancel handling) is testable with a
 * fake compress function instead of a live LLM call and TUI.
 */

import type { ManageContextState, MarkInfo, Mark } from "./state.ts";
import type { TurnUnit } from "./turn-units.ts";

export interface CompressionEvent {
	kind: "done" | "error" | "cancelled";
	unit: TurnUnit;
	/** Realized compression stats, for "done" events. */
	text?: string;
	compressedTokenEstimate?: number;
	message?: string;
}

/**
 * Runs compressions one at a time over the marked units, updating marks via
 * the resolve callback (which owns the state mutation policy) and reporting
 * progress through events.
 *
 * Mark resolution policy, kept identical to the pre-extraction behavior: a
 * successful compression writes compressedText and resets the mark to
 * "selected" (buildFilteredMessages keeps serving the compressed text, see
 * context-filter.ts); a failed one leaves the mark as-is — no compressedText,
 * so the filter falls back to the original content.
 */
export class CompressionQueue {
	private cancelled = false;
	private done = 0;
	private total = 0;

	private readonly compress: (unit: TurnUnit) => Promise<string>;
	private readonly onEvent: (event: CompressionEvent, progress: { done: number; total: number }) => void;
	private readonly resolveMark: (unit: TurnUnit, info: MarkInfo) => void;

	constructor(
		compress: (unit: TurnUnit) => Promise<string>,
		onEvent: (event: CompressionEvent, progress: { done: number; total: number }) => void,
		resolveMark: (unit: TurnUnit, info: MarkInfo) => void,
	) {
		this.compress = compress;
		this.onEvent = onEvent;
		this.resolveMark = resolveMark;
	}

	cancel(): void {
		this.cancelled = true;
	}

	get progress(): { done: number; total: number } {
		return { done: this.done, total: this.total };
	}

	async run(units: TurnUnit[]): Promise<void> {
		this.total = units.length;
		this.done = 0;
		for (const unit of units) {
			if (this.cancelled) break;
			try {
				const text = await this.compress(unit);
				const info: MarkInfo = {
					mark: "selected" as Mark,
					compressedText: text,
					compressedAt: new Date().toISOString(),
					originalTokenEstimate: unit.tokenEstimate,
					compressedTokenEstimate: Math.ceil(text.length / 4),
				};
				this.resolveMark(unit, info);
				this.done++;
				this.onEvent({ kind: "done", unit, text, compressedTokenEstimate: info.compressedTokenEstimate }, this.progress);
			} catch (err) {
				this.done++;
				if (this.cancelled) {
					this.onEvent({ kind: "cancelled", unit }, this.progress);
				} else {
					this.onEvent({ kind: "error", unit, message: err instanceof Error ? err.message : String(err) }, this.progress);
				}
			}
		}
	}
}

/** Convenience for the picker: wire queue results into a state's marks. */
export function defaultResolveMark(state: ManageContextState): (unit: TurnUnit, info: MarkInfo) => void {
	return (unit, info) => {
		state.marks[unit.groupId] = info;
	};
}
