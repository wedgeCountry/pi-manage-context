/**
 * Unit tests for the plain, ExtensionContext-free halves of
 * context-autoselect: buildAutoListing() (the rows offered to the subagent),
 * buildAutoSelectTask() (the subagent prompt), and summarizeAutoResult()
 * (the parent-facing tool result).
 */
import { describe, expect, it } from "vitest";
import {
	buildAutoListing,
	buildAutoSelectTask,
	summarizeAutoResult,
} from "../src/tools/context-autoselect-engine.ts";
import { emptyState } from "../src/state.ts";
import type { TurnUnit } from "../src/turn-units.ts";

function makeUnit(groupId: string, kind: TurnUnit["kind"], heading: string, opts: Partial<TurnUnit> = {}): TurnUnit {
	return {
		groupId,
		kind,
		entryIds: [groupId],
		anchorEntry: {} as TurnUnit["anchorEntry"],
		resultEntries: [],
		timestamp: "0",
		preview: heading,
		tokenEstimate: 42,
		metadata: {
			heading,
			type: kind === "user" ? "user_message" : "assistant_response",
			timestamp: "0",
			summary: heading,
		},
		...opts,
	};
}

describe("buildAutoListing", () => {
	it("returns one compact row per unit with groupId, heading, type, tokenEstimate, summary, and mark", () => {
		const units = [
			makeUnit("e1", "assistant_text", "first answer"),
			makeUnit("e2", "assistant_text", "second answer"),
			makeUnit("e3", "user", "current question"),
		];
		const state = emptyState();
		state.marks.e2 = { mark: "unselected" };

		const listing = buildAutoListing(units, state);

		expect(listing).toHaveLength(2);
		expect(listing[0]).toMatchObject({
			groupId: "e1",
			heading: "first answer",
			type: "assistant_response",
			tokenEstimate: 42,
			summary: "first answer",
			mark: "selected",
		});
		expect(listing[1].mark).toBe("unselected");
	});

	it("excludes only the LATEST user unit, keeping earlier user units as candidates", () => {
		const units = [
			makeUnit("e1", "user", "old question"),
			makeUnit("e2", "assistant_text", "old answer"),
			makeUnit("e3", "user", "current question"),
		];

		const listing = buildAutoListing(units, emptyState());

		expect(listing.map((r) => r.groupId)).toEqual(["e1", "e2"]);
	});

	it("caps the summary length while preserving line breaks", () => {
		const longSummary = Array.from({ length: 50 }, (_, i) => `line ${i} with some content`).join("\n");
		const units = [
			makeUnit("e1", "user", "q"),
			makeUnit("e2", "assistant_text", "a", {
				metadata: { heading: "a", type: "assistant_response", timestamp: "0", summary: longSummary },
			}),
		];

		const listing = buildAutoListing(units, emptyState());
		const row = listing.find((r) => r.groupId === "e2")!;

		expect(row.summary.length).toBeLessThanOrEqual(1000);
		expect(row.summary).toContain("\n");
		expect(row.summary.endsWith("…")).toBe(true);
	});

	it("flattens the heading to one line", () => {
		const units = [
			makeUnit("e1", "user", "q"),
			makeUnit("e2", "assistant_text", "line one\nline two\nline three"),
		];

		const listing = buildAutoListing(units, emptyState());
		const row = listing.find((r) => r.groupId === "e2")!;

		expect(row.heading).not.toContain("\n");
	});
});

describe("buildAutoSelectTask", () => {
	it("embeds the listing as JSON, the focus, and the one-call conservative instructions", () => {
		const listing = buildAutoListing([makeUnit("e1", "assistant_text", "answer")], emptyState());

		const task = buildAutoSelectTask(listing, "fixing the auth bug");

		expect(task).toContain("fixing the auth bug");
		expect(task).toContain('"groupId": "e1"');
		expect(task).toContain("context-unselect ONCE");
		expect(task).toMatch(/conservative/i);
		expect(task).toMatch(/latest user turn is not in this list/i);
	});

	it("notes when no focus was provided", () => {
		const task = buildAutoSelectTask([], undefined);
		expect(task).toMatch(/not specified/i);
	});
});

describe("summarizeAutoResult", () => {
	it("lists the unselected ids", () => {
		const text = summarizeAutoResult({ unselected: ["e1", "e2"], dryRun: false });
		expect(text).toContain("unselected 2 unit(s)");
		expect(text).toContain("e1");
		expect(text).toContain("e2");
		expect(text).not.toContain("dry run");
	});

	it("flags dry runs and does not claim persistence", () => {
		const text = summarizeAutoResult({ unselected: ["e1"], dryRun: true });
		expect(text).toMatch(/dry run/i);
		expect(text).toMatch(/nothing was persisted/i);
	});

	it("reports when nothing was unselected", () => {
		expect(summarizeAutoResult({ unselected: [], dryRun: false })).toMatch(/no units to unselect/i);
		expect(summarizeAutoResult({ unselected: [], dryRun: true })).toMatch(/no units to unselect/i);
	});
});
