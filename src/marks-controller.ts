/**
 * Pure mark transitions for the interactive picker, extracted from
 * ManageContextView so they're testable without a TUI: current marks plus a
 * key intent in, next marks out. No rendering, no session access.
 */

import type { Mark, ManageContextState } from "./state.ts";
import { markStatus } from "./mark-status.ts";

export type MarkIntent = "toggle-unselected" | "toggle-compressed" | "toggle-deleted";

/**
 * The picker's mark keys are toggles: pressing the same key again reverts
 * to "selected". Setting a different mark replaces the current one. A
 * realized compression (compressedText present, mark already back to
 * "selected") reads as "compressed", so pressing c/space/d on it behaves
 * like toggling off a compression — the intent match is against the
 * effective mark.
 */
export class MarksController {
	private readonly state: ManageContextState;
	/** The groupIds being managed — counts are scoped to these, not to every stored mark. */
	private readonly groupIds: readonly string[];

	constructor(state: ManageContextState, groupIds: readonly string[]) {
		this.state = state;
		this.groupIds = groupIds;
	}

	/** The mark a row should display (realized compressions read as "compressed"). */
	effectiveMark(groupId: string): Mark {
		return markStatus(this.state, groupId).effective;
	}

	rawMark(groupId: string): Mark {
		return markStatus(this.state, groupId).raw;
	}

	countBy(mark: Mark): number {
		return this.groupIds.filter((id) => this.effectiveMark(id) === mark).length;
	}

	/**
	 * Apply a toggle intent for one unit. Mutates state.marks in place and
	 * returns the resulting effective mark (for immediate re-render).
	 */
	apply(groupId: string, intent: MarkIntent): Mark {
		const target: Mark =
			intent === "toggle-unselected" ? "unselected" : intent === "toggle-compressed" ? "compressed" : "deleted";

		const current = this.effectiveMark(groupId);
		const existing = this.state.marks[groupId];
		if (current === target) {
			// pressing the same key again reverts to "selected"
			this.state.marks[groupId] = { ...existing, mark: "selected" };
		} else {
			this.state.marks[groupId] = { ...existing, mark: target };
		}
		return this.effectiveMark(groupId);
	}
}
