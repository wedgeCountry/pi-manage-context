/**
 * One place that decides how a unit's mark reads, for every surface: the
 * picker's rows and glyphs, view_context's summary/detailed/llm-json
 * formats, and manage-context's list output. Before this module existed,
 * each surface re-derived "effective" status from raw marks with slightly
 * different rules (view_context counted compressed by compressedText, the
 * picker by effectiveMark, manage-context by a mix of both), so the three
 * could disagree about the same unit.
 *
 * The key subtlety this encodes: a realized compression resets the stored
 * mark back to "selected" (see runCompressions in view.ts) while
 * buildFilteredMessages keeps serving compressedText in its place
 * (context-filter.ts). The *effective* status is therefore "compressed"
 * whenever compressedText exists, regardless of the raw mark — and every
 * surface must report that, or the model reasons about content it never
 * actually sees.
 */

import type { MarkInfo, ManageContextState, Mark } from "./state.ts";
import type { TurnUnit } from "./turn-units.ts";

export interface MarkStatus {
	/** The status a user/LLM should see: accounts for realized compressions. */
	effective: Mark;
	/** The raw persisted mark, for surfaces that need the stored value. */
	raw: Mark;
	/** The persisted MarkInfo, if any. */
	info?: MarkInfo;
	/** Row glyph for pickers/list renderers. */
	symbol: string;
	/** Short bracketed label, e.g. "[hidden]" — empty for plain selected. */
	label: string;
}

export function markStatus(state: ManageContextState, groupId: string, tokenEstimate?: number): MarkStatus {
	const info = state.marks[groupId];
	const raw = info?.mark ?? "selected";
	// Realized compression: stored mark resolves to "selected" but the unit
	// is served as compressedText — read as "compressed" until the user
	// overrides it (unselect/delete/re-queue).
	const effective: Mark = raw === "selected" && info?.compressedText ? "compressed" : raw;
	return {
		effective,
		raw,
		info,
		symbol: symbolFor(effective),
		label: labelFor(effective),
	};
}

export function describeMark(unit: TurnUnit, state: ManageContextState): MarkStatus {
	return markStatus(state, unit.groupId, unit.tokenEstimate);
}

function symbolFor(mark: Mark): string {
	switch (mark) {
		case "selected":
			return "●";
		case "unselected":
			return "○";
		case "compressed":
			return "▤";
		case "deleted":
			return "✕";
	}
}

function labelFor(mark: Mark): string {
	switch (mark) {
		case "selected":
			return "";
		case "unselected":
			return "[hidden]";
		case "compressed":
			return "[compressed]";
		case "deleted":
			return "[deleted]";
	}
}
