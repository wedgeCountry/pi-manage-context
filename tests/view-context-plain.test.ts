/**
 * Unit tests for the plain, ExtensionContext-free core of the view_context
 * tool: buildContextOverview() operates on TurnUnit[]/ManageContextState
 * directly, so these tests build fixtures by hand instead of mocking
 * sessionManager.
 */
import { describe, expect, it } from "vitest";
import { buildContextOverview, formatLLMJSON, formatSummary } from "../src/tools/view-context.ts";
import type { ManageContextState } from "../src/state.ts";
import type { TurnUnit } from "../src/turn-units.ts";

function makeUnit(groupId: string, kind: TurnUnit["kind"], heading: string): TurnUnit {
	return {
		groupId,
		kind,
		entryIds: [groupId],
		anchorEntry: {} as TurnUnit["anchorEntry"],
		resultEntries: [],
		timestamp: "0",
		preview: heading,
		tokenEstimate: 10,
		metadata: {
			heading,
			type: kind === "user" ? "user_message" : "assistant_response",
			timestamp: "0",
			summary: heading,
			importanceScore: 50,
		},
	};
}

function emptyState(): ManageContextState {
	return { version: 1, marks: {}, readHookEnabled: false };
}

describe("buildContextOverview", () => {
	it("reports the empty-context message when there are no units", () => {
		const result = buildContextOverview([], emptyState(), {});
		expect(result.text).toBe("No entries in context yet.");
		expect(result.details).toEqual({ units: [], totalTokens: 0 });
	});

	it("defaults to the summary format", () => {
		const units = [makeUnit("e1", "user", "Hello"), makeUnit("e2", "assistant_text", "Hi there")];
		const result = buildContextOverview(units, emptyState(), {});
		expect(result.text).toContain("CONTEXT OVERVIEW");
		expect(result.text).toContain("Total entries: 2");
	});

	it("routes to llm-json and includes summary counts + entries", () => {
		const units = [makeUnit("e1", "user", "Hello")];
		const result = buildContextOverview(units, emptyState(), { format: "llm-json" });
		const json = JSON.parse(result.text);
		expect(json.summary.totalEntries).toBe(1);
		expect(json.entries).toHaveLength(1);
	});

	it("includes totalEntries/totalTokens in details for a non-empty overview", () => {
		const units = [makeUnit("e1", "user", "Hello"), makeUnit("e2", "assistant_text", "Hi there")];
		const result = buildContextOverview(units, emptyState(), { format: "summary" });
		expect(result.details).toMatchObject({ totalEntries: 2, totalTokens: 20 });
	});
});

describe("formatSummary", () => {
	it("counts selected/unselected/deleted units by mark", () => {
		const units = [makeUnit("e1", "user", "A"), makeUnit("e2", "user", "B")];
		const state: ManageContextState = { version: 1, marks: { e2: { mark: "unselected" } }, readHookEnabled: false };

		const text = formatSummary(units, state, false);
		expect(text).toContain("1 selected");
		expect(text).toContain("1 unselected");
	});
});

describe("formatLLMJSON", () => {
	it("marks a compressed unit's status as compressed", () => {
		const units = [makeUnit("e1", "user", "A")];
		const state: ManageContextState = {
			version: 1,
			marks: { e1: { mark: "compressed", compressedText: "summary", originalTokenEstimate: 100, compressedTokenEstimate: 10 } },
			readHookEnabled: false,
		};

		const json = JSON.parse(formatLLMJSON(units, state));
		expect(json.entries[0].status).toBe("compressed");
		expect(json.entries[0].compression).toEqual({ originalTokens: 100, compressedTokens: 10 });
	});
});
