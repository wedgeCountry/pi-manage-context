/**
 * Unit tests for the plain, ExtensionContext-free core shared by
 * context-select and context-unselect: runContextMark() operates on
 * TurnUnit[]/ManageContextState directly, so these tests build fixtures by
 * hand instead of mocking sessionManager.
 */
import { describe, expect, it } from "vitest";
import { runContextMark } from "../src/tools/context-mark.ts";
import { emptyState, type ManageContextState } from "../src/state.ts";
import type { TurnUnit } from "../src/turn-units.ts";

function makeUnit(groupId: string, heading: string, opts: Partial<TurnUnit> = {}): TurnUnit {
	return {
		groupId,
		kind: "user",
		entryIds: [groupId],
		anchorEntry: {} as TurnUnit["anchorEntry"],
		resultEntries: [],
		timestamp: "0",
		preview: heading,
		tokenEstimate: 10,
		metadata: {
			heading,
			type: "user_message",
			timestamp: "0",
			summary: heading,
		},
		...opts,
	};
}

describe("runContextMark", () => {
	it("selects units by groupId only and reports changed:true with the affected ids", () => {
		const units = [makeUnit("e1", "Draft implementation"), makeUnit("e2", "Final implementation")];
		const state = emptyState();

		const result = runContextMark(units, state, ["e1"], "select", "context-select");

		expect(result.changed).toBe(true);
		expect(result.details).toEqual(["e1"]);
		expect(state.marks.e1?.mark).toBe("selected");
		expect(state.marks.e2).toBeUndefined();
	});

	it("unselects units by groupId, preserving other mark fields (e.g. compressedText)", () => {
		const units = [makeUnit("e1", "Long explanation")];
		const state = emptyState();
		state.marks.e1 = { mark: "selected", compressedText: "summary" };

		const result = runContextMark(units, state, ["e1"], "unselect", "context-unselect");

		expect(result.changed).toBe(true);
		expect(state.marks.e1?.mark).toBe("unselected");
		expect(state.marks.e1?.compressedText).toBe("summary");
	});

	it("is an empty-array no-op: changed:false, state untouched, and says so", () => {
		const units = [makeUnit("e1", "hi there")];
		const state = emptyState();

		const result = runContextMark(units, state, [], "unselect", "context-unselect");

		expect(result.changed).toBe(false);
		expect(result.details).toEqual([]);
		expect(result.content[0].text).toMatch(/no groupIds given/i);
		expect(state.marks).toEqual({});
	});

	it("does not match by text — a groupId that no unit has matches nothing", () => {
		const units = [makeUnit("e1", "Please refactor the auth module")];
		const state = emptyState();

		// "refactor" appears in the heading, but matching is groupId-only.
		const result = runContextMark(units, state, ["refactor"], "unselect", "context-unselect");

		expect(result.changed).toBe(false);
		expect(result.content[0].text).toMatch(/no turn units matched/i);
		expect(state.marks).toEqual({});
	});

	it("reports unknown groupIds as not matched and only applies the known ones", () => {
		const units = [makeUnit("e1", "hi there")];
		const state = emptyState();

		const result = runContextMark(units, state, ["e1", "nope-1", "nope-2"], "unselect", "context-unselect");

		expect(result.changed).toBe(true);
		expect(result.details).toEqual(["e1"]);
		expect(state.marks.e1?.mark).toBe("unselected");
		expect(result.content[0].text).toContain("nope-1");
		expect(result.content[0].text).toContain("nope-2");
		expect(result.content[0].text).toMatch(/not matched/i);
	});

	it("previews each matched unit (id, heading, previous mark) in the output before mutating", () => {
		const units = [makeUnit("e1", "Draft implementation"), makeUnit("e2", "Final implementation")];
		const state = emptyState();
		state.marks.e2 = { mark: "unselected" };

		const result = runContextMark(units, state, ["e1", "e2"], "select", "context-select");

		const text = result.content[0].text;
		expect(text).toContain("Marked 2 unit(s) as selected:");
		expect(text).toContain("e1");
		expect(text).toContain("Draft implementation");
		expect(text).toContain("(was: selected)");
		expect(text).toContain("e2");
		expect(text).toContain("(was: unselected)");
		expect(state.marks.e1?.mark).toBe("selected");
		expect(state.marks.e2?.mark).toBe("selected");
	});

	it("names the calling tool in the empty-array no-op message", () => {
		const state: ManageContextState = emptyState();
		const result = runContextMark([], state, [], "select", "context-select");
		expect(result.content[0].text).toContain("context-select:");
	});
});
