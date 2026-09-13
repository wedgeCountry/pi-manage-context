/**
 * Unit tests for the plain, ExtensionContext-free core of the manage-context
 * tool: runManageContext() operates on TurnUnit[]/ManageContextState directly,
 * so these tests build fixtures by hand instead of mocking sessionManager.
 */
import { describe, expect, it } from "vitest";
import { runManageContext, unitMatches, unitSearchText } from "../src/tools/manage-context.ts";
import type { ManageContextState } from "../src/state.ts";
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
			importanceScore: 50,
		},
		...opts,
	};
}

function emptyState(): ManageContextState {
	return { version: 1, marks: {}, readHookEnabled: false };
}

describe("unitSearchText / unitMatches", () => {
	it("flattens heading, summary, and tool call fields into one lowercased string", () => {
		const unit = makeUnit("e1", "Tool interactions", {
			metadata: {
				heading: "Tool interactions",
				type: "tool_interaction",
				timestamp: "0",
				summary: "Executed write_file",
				importanceScore: 60,
				toolCalls: [{ name: "write_file", arguments: { path: "poem.txt" }, result: "Wrote poem.txt", description: "✓ Wrote poem.txt" }],
			},
		});

		expect(unitSearchText(unit)).toContain("poem.txt");
		expect(unitMatches(unit, "POEM", undefined)).toBe(true);
	});

	it("matches by groupId even when textMatch doesn't hit", () => {
		const unit = makeUnit("e1", "hi there");
		expect(unitMatches(unit, "nonexistent", ["e1"])).toBe(true);
	});

	it("matches nothing when neither textMatch nor groupIds is given", () => {
		const unit = makeUnit("e1", "hi there");
		expect(unitMatches(unit, undefined, undefined)).toBe(false);
	});
});

describe("runManageContext", () => {
	it("list reports every unit with its current mark, without mutating state", () => {
		const units = [makeUnit("e1", "Please refactor the auth module"), makeUnit("e2", "hi there")];
		const state = emptyState();

		const result = runManageContext(units, state, { action: "list" }, "manage-context");

		const rows = JSON.parse(result.content[0].text) as Array<{ id: string; mark: string }>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: "e1", mark: "selected" });
		expect(result.changed).toBe(false);
	});

	it("select/unselect mutate state.marks and report changed:true for affected units", () => {
		const units = [makeUnit("e1", "Draft implementation"), makeUnit("e2", "Final implementation")];
		const state = emptyState();

		const result = runManageContext(units, state, { action: "unselect", textMatch: "draft" }, "manage-context");

		expect(result.changed).toBe(true);
		expect(result.details).toEqual(["e1"]);
		expect(state.marks.e1?.mark).toBe("unselected");
		expect(state.marks.e2).toBeUndefined();
	});

	it("reports changed:false and a no-match message when nothing matches", () => {
		const units = [makeUnit("e1", "hi there")];
		const state = emptyState();

		const result = runManageContext(units, state, { action: "select", textMatch: "nonexistent" }, "manage-context");

		expect(result.changed).toBe(false);
		expect(result.content[0].text).toMatch(/no turn units matched/i);
	});

	it("refuses select/unselect without textMatch or groupIds, naming the calling tool", () => {
		const units = [makeUnit("e1", "hi there")];
		const state = emptyState();

		const result = runManageContext(units, state, { action: "select" }, "manage_context_select");

		expect(result.changed).toBe(false);
		expect(result.content[0].text).toBe("manage_context_select: provide textMatch and/or groupIds to select/unselect units.");
	});
});
