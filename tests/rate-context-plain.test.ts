/**
 * Unit tests for the pure, ExtensionContext-free halves of the rate-context
 * tool (the context-autoselect subagent's only tool): isValidRating(),
 * formatRatingsExport() / rateContextExportFilename() (the export file of the
 * tool's input), and runRateContext() (threshold split + unselect via
 * runContextMark, unknown/invalid rating handling).
 */
import { describe, expect, it } from "vitest";

import {
	DEFAULT_RATE_THRESHOLD,
	formatRatingsExport,
	isValidRating,
	rateContextExportFilename,
	runRateContext,
	type ContextRating,
} from "../src/tools/rate-context.ts";
import { emptyState, type ManageContextState } from "../src/state.ts";
import { buildTurnUnits } from "../src/turn-units.ts";
import { userEntry, assistantTextEntry } from "./helpers.ts";

function makeUnits() {
	return buildTurnUnits([
		userEntry("e1", "old brainstorming about a side project"),
		assistantTextEntry("e2", "Sure, here are ideas..."),
		userEntry("e3", "now fix the login bug"),
	]);
}

function ratings(...rows: [id: string, score: number, reason: string][]): ContextRating[] {
	return rows.map(([id, score, reason]) => ({ id, score, reason }));
}

describe("isValidRating", () => {
	it("accepts scores within 1-10 and rejects anything else", () => {
		expect(isValidRating({ id: "e1", score: 1, reason: "" })).toBe(true);
		expect(isValidRating({ id: "e1", score: 10, reason: "" })).toBe(true);
		expect(isValidRating({ id: "e1", score: 5.5, reason: "" })).toBe(true);
		expect(isValidRating({ id: "e1", score: 0, reason: "" })).toBe(false);
		expect(isValidRating({ id: "e1", score: 11, reason: "" })).toBe(false);
		expect(isValidRating({ id: "e1", score: Number.NaN, reason: "" })).toBe(false);
	});
});

describe("formatRatingsExport / rateContextExportFilename", () => {
	it("renders a markdown table of the input ratings plus the threshold", () => {
		const md = formatRatingsExport(ratings(["e1", 2, "outdated draft"], ["e2", 9, "still relevant"]), 5);

		expect(md).toContain("# Context Ratings Export");
		expect(md).toContain("**Tool**: rate-context");
		expect(md).toContain("**Threshold**: 5 (entries scored below are unselected)");
		expect(md).toContain("| ID | Score | Reason |");
		expect(md).toContain("| e1 | 2 | outdated draft |");
		expect(md).toContain("| e2 | 9 | still relevant |");
	});

	it("flattens multi-line reasons and escapes pipes so the table stays parseable", () => {
		const md = formatRatingsExport([{ id: "e1", score: 3, reason: "line one\nline two | piped" }], 5);
		const row = md.split("\n").find((l) => l.startsWith("| e1 |"))!;
		expect(row).toBe("| e1 | 3 | line one line two \\| piped |");
	});

	it("generates a plain timestamped .md filename (no path separators)", () => {
		const name = rateContextExportFilename(new Date("2026-01-02T03:04:05.678Z"));
		expect(name).toBe("context-ratings-2026-01-02T03-04-05-678Z.md");
		expect(name).not.toMatch(/[:/\\]/);
	});
});

describe("runRateContext", () => {
	it("unselects exactly the entries scored below the threshold and leaves the rest alone", () => {
		const units = makeUnits();
		const state: ManageContextState = emptyState();

		const result = runRateContext(units, state, {
			ratings: ratings(["e1", 2, "outdated"], ["e2", 9, "relevant"], ["e3", 4, "stale task"]),
			threshold: 5,
		});

		expect(result.changed).toBe(true);
		expect(result.details.unselected).toEqual(["e1", "e3"]);
		expect(result.details.threshold).toBe(5);
		expect(state.marks.e1?.mark).toBe("unselected");
		expect(state.marks.e3?.mark).toBe("unselected");
		expect(state.marks.e2).toBeUndefined();
		expect(result.content[0].text).toContain("rated 3 entries with threshold 5");
		expect(result.content[0].text).toContain("Marked 2 unit(s) as unselected");
		expect(result.details.exportMarkdown).toContain("| e2 | 9 | relevant |");
	});

	it("keeps entries scored exactly AT the threshold (only strictly below is unselected)", () => {
		const units = makeUnits();
		const state = emptyState();

		const result = runRateContext(units, state, { ratings: ratings(["e1", 5, "borderline"]), threshold: 5 });

		expect(result.changed).toBe(false);
		expect(result.details.unselected).toEqual([]);
		expect(state.marks).toEqual({});
		expect(result.content[0].text).toMatch(/nothing unselected/i);
	});

	it("defaults the threshold to 5 when omitted or not a number", () => {
		for (const threshold of [undefined, Number.NaN] as (number | undefined)[]) {
			const units = makeUnits();
			const state = emptyState();
			const result = runRateContext(units, state, { ratings: ratings(["e1", 4, "low"], ["e2", 6, "high"]), threshold });
			expect(result.details.threshold).toBe(DEFAULT_RATE_THRESHOLD);
			expect(result.details.unselected).toEqual(["e1"]);
		}
	});

	it("clamps an out-of-range threshold into 0-10", () => {
		const units = makeUnits();
		const state = emptyState();
		const result = runRateContext(units, state, { ratings: ratings(["e1", 9, "nine"], ["e2", 10, "ten"]), threshold: 99 });
		expect(result.details.threshold).toBe(10);
		expect(result.details.unselected).toEqual(["e1"]); // 9 < 10, but 10 is not below 10
		expect(state.marks.e2).toBeUndefined();
	});

	it("reports unknown ids as not matched and never applies them", () => {
		const units = makeUnits();
		const state = emptyState();

		const result = runRateContext(units, state, {
			ratings: ratings(["bogus", 1, "invented"], ["e1", 8, "fine"]),
			threshold: 5,
		});

		expect(result.details.unselected).toEqual([]);
		expect(result.details.notMatched).toEqual(["bogus"]);
		expect(result.changed).toBe(false);
		expect(state.marks).toEqual({});
		expect(result.content[0].text).toContain("bogus");
	});

	it("ignores ratings with a score outside 1-10 instead of unselecting them", () => {
		const units = makeUnits();
		const state = emptyState();

		const result = runRateContext(units, state, {
			ratings: [
				{ id: "e1", score: 0, reason: "zero is invalid" },
				{ id: "e2", score: 42, reason: "out of range" },
			],
			threshold: 5,
		});

		expect(result.details.invalid.map((r) => r.id)).toEqual(["e1", "e2"]);
		expect(result.details.unselected).toEqual([]);
		expect(result.changed).toBe(false);
		expect(state.marks).toEqual({});
		expect(result.content[0].text).toMatch(/outside 1-10/i);
	});

	it("an empty ratings array is a no-op but still produces the export markdown", () => {
		const units = makeUnits();
		const state = emptyState();

		const result = runRateContext(units, state, { ratings: [], threshold: 5 });

		expect(result.changed).toBe(false);
		expect(result.details.unselected).toEqual([]);
		expect(result.content[0].text).toContain("rated 0 entries");
		expect(result.details.exportMarkdown).toContain("**Ratings**: 0");
	});
});
