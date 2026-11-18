/**
 * Integration tests for the rate-context tool — the context-autoselect
 * subagent's only tool — driven through the in-memory pi stand-in (state
 * round-trips via appendEntry) with a MOCKED SUBAGENT: a dependency-injected
 * fake child-session factory that captures the task prompt and the child
 * toolset, then invokes the child's rate-context call with scripted ratings,
 * exactly like tests/context-tools.test.ts does for the autoselect flow.
 *
 * Covered: tool definition shape; the subagent receives the context text list
 * + the rate-context instruction; the export file of the ratings is written to
 * the cwd; entries scored below the threshold are unselected in the PARENT
 * session state (and only those); unknown ids rejected; invalid scores
 * ignored; dryRun records without persisting.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { userEntry, assistantTextEntry, makeHarness } from "./helpers.ts";
import { RATE_CONTEXT_TOOL_DEFINITION } from "../src/tool_definitions/rate-context.ts";
import { buildChildRateContextTool, type ContextRating } from "../src/tools/rate-context.ts";
import { runAutoSelect, type AutoSelectChildOptions, type AutoSelectSessionFactory } from "../src/tools/context-autoselect-engine.ts";
import { loadState } from "../src/state.ts";
import { buildTurnUnits } from "../src/turn-units.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mc-rate-context-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function setup() {
	const entries: SessionEntry[] = [
		userEntry("e1", "old brainstorming about a side project"),
		assistantTextEntry("e2", "Sure, here are ideas..."),
		assistantTextEntry("e3", "login bug analysis"),
		userEntry("e4", "now fix the login bug"),
	];
	const harness = makeHarness(entries, { cwd: dir });
	const units = buildTurnUnits(entries);
	const state = loadState(harness.ctx);
	return { ...harness, entries, units, state };
}

async function readRatingsExports(): Promise<string[]> {
	const files = (await readdir(dir)).filter((f) => f.startsWith("context-ratings-") && f.endsWith(".md"));
	return Promise.all(files.map((f) => readFile(join(dir, f), "utf-8")));
}

describe("rate-context tool definition", () => {
	it("is named rate-context, sequential, with a required ratings tuple list and an optional threshold", () => {
		expect(RATE_CONTEXT_TOOL_DEFINITION.name).toBe("rate-context");
		expect(RATE_CONTEXT_TOOL_DEFINITION.executionMode).toBe("sequential");

		const params = RATE_CONTEXT_TOOL_DEFINITION.parameters as any;
		expect(params.required).toContain("ratings");
		expect(params.properties.ratings.type).toBe("array");
		const item = params.properties.ratings.items;
		expect(item.type).toBe("object");
		expect(Object.keys(item.properties)).toEqual(["id", "score", "reason"]);
		expect(item.properties.id.type).toBe("string");
		expect(item.properties.score.type).toBe("number");
		expect(item.properties.score.minimum).toBe(1);
		expect(item.properties.score.maximum).toBe(10);
		expect(item.properties.reason.type).toBe("string");
		expect(params.properties.threshold.type).toBe("number");
		expect(params.required).not.toContain("threshold");
	});
});

describe("rate-context child tool (direct execution)", () => {
	it("writes the ratings export file to the cwd and unselects below-threshold entries in the parent state", async () => {
		const { pi, ctx, units } = setup();
		const unselected: string[] = [];
		const tool = buildChildRateContextTool(pi, ctx, units, false, unselected);

		const result = await tool.execute(
			"call_1",
			{
				ratings: [
					{ id: "e1", score: 2, reason: "outdated brainstorming" },
					{ id: "e2", score: 9, reason: "still relevant" },
					{ id: "e3", score: 3, reason: "superseded by later analysis" },
				],
				threshold: 5,
			},
			undefined,
			undefined,
			{} as any,
		);

		expect(result.details.unselected).toEqual(["e1", "e3"]);
		expect(unselected).toEqual(["e1", "e3"]);
		expect(loadState(ctx).marks.e1?.mark).toBe("unselected");
		expect(loadState(ctx).marks.e3?.mark).toBe("unselected");
		expect(loadState(ctx).marks.e2).toBeUndefined();

		const text = (result.content[0] as any).text;
		expect(text).toContain("rated 3 entries with threshold 5");
		expect(text).toMatch(/Ratings export written to /);
		expect(result.details.exportedFile).toBe(join(dir, (await readdir(dir)).find((f) => f.startsWith("context-ratings-"))!));

		const exports = await readRatingsExports();
		expect(exports).toHaveLength(1);
		expect(exports[0]).toContain("# Context Ratings Export");
		expect(exports[0]).toContain("**Threshold**: 5");
		expect(exports[0]).toContain("| e1 | 2 | outdated brainstorming |");
		expect(exports[0]).toContain("| e3 | 3 | superseded by later analysis |");
	});

	it("under dryRun records the would-be unselects and writes the export, but persists no marks", async () => {
		const { pi, ctx, units } = setup();
		const unselected: string[] = [];
		const tool = buildChildRateContextTool(pi, ctx, units, true, unselected);

		const result = await tool.execute(
			"call_1",
			{ ratings: [{ id: "e1", score: 1, reason: "outdated" }], threshold: 5 },
			undefined,
			undefined,
			{} as any,
		);

		expect(result.details.unselected).toEqual(["e1"]);
		expect(unselected).toEqual(["e1"]);
		expect(loadState(ctx).marks).toEqual({}); // nothing persisted
		expect(await readRatingsExports()).toHaveLength(1); // export of the input still written
	});

	it("rejects unknown ids and ignores out-of-range scores without touching state", async () => {
		const { pi, ctx, units } = setup();
		const tool = buildChildRateContextTool(pi, ctx, units, false, []);

		const result = await tool.execute(
			"call_1",
			{
				ratings: [
					{ id: "bogus", score: 1, reason: "invented" },
					{ id: "e1", score: 0, reason: "invalid score" },
				],
				threshold: 5,
			},
			undefined,
			undefined,
			{} as any,
		);

		expect(result.details.unselected).toEqual([]);
		expect(result.details.notMatched).toEqual(["bogus"]);
		expect(result.details.invalid.map((r: ContextRating) => r.id)).toEqual(["e1"]);
		expect(loadState(ctx).marks).toEqual({});
	});
});

describe("rate-context via the mocked subagent (context-autoselect)", () => {
	/** Fake child session: captures the task + toolset, then plays the subagent by calling rate-context once. */
	function makeFakeSubagent(childRatings: ContextRating[], threshold?: number) {
		let captured: AutoSelectChildOptions | undefined;
		let task = "";
		const factory: AutoSelectSessionFactory = async (options) => {
			captured = options;
			return {
				prompt: async (t: string) => {
					task = t;
					await options.customTools[0].execute("child-call-1", { ratings: childRatings, threshold }, undefined, undefined, {} as any);
				},
				abort: vi.fn(),
				dispose: vi.fn(),
				subscribe: () => () => {},
			};
		};
		return { factory, getCaptured: () => captured, getTask: () => task };
	}

	it("the subagent gets the context text list + the rate-context instruction, and rate-context as its ONLY tool", async () => {
		const { pi, ctx, units, state } = setup();
		const { factory, getCaptured, getTask } = makeFakeSubagent([]);

		await runAutoSelect(pi, ctx, units, state, { focus: "fixing the login bug" }, undefined, factory);

		expect(getCaptured()!.customTools.map((t) => t.name)).toEqual(["rate-context"]);

		const task = getTask();
		// The output of the manage-context text list:
		expect(task).toContain("Context text list");
		expect(task).toContain("- ID: e1");
		expect(task).toContain("- ID: e2");
		expect(task).toContain("- ID: e3");
		expect(task).not.toContain("- ID: e4"); // latest user turn never offered
		// The system prompt about rating:
		expect(task).toContain("fixing the login bug");
		expect(task).toMatch(/call the rate-context tool with a list of tuples/i);
		expect(task).toMatch(/between 1 and 10/);
		expect(task).toMatch(/outdated/);
	});

	it("the mocked subagent's below-threshold ratings unselect exactly those entries in the parent state and write the export file", async () => {
		const { pi, ctx, units, state } = setup();
		const { factory } = makeFakeSubagent(
			[
				{ id: "e1", score: 2, reason: "outdated brainstorming" },
				{ id: "e2", score: 8, reason: "relevant background" },
				{ id: "e3", score: 5, reason: "borderline — exactly at threshold stays" },
			],
			5,
		);

		const result = await runAutoSelect(pi, ctx, units, state, { focus: "fixing the login bug" }, undefined, factory);

		expect(result.details).toEqual({ unselected: ["e1"], dryRun: false });
		expect((result.content[0] as any).text).toContain("unselected 1 unit(s)");

		const marks = loadState(ctx).marks;
		expect(marks.e1?.mark).toBe("unselected");
		expect(marks.e2).toBeUndefined();
		expect(marks.e3).toBeUndefined(); // score 5 is not below threshold 5

		const exports = await readRatingsExports();
		expect(exports).toHaveLength(1);
		expect(exports[0]).toContain("| e1 | 2 | outdated brainstorming |");
		expect(exports[0]).toContain("| e3 | 5 | borderline — exactly at threshold stays |");
	});

	it("a high threshold unselects every rated entry; dryRun persists none of them", async () => {
		const { pi, ctx, units, state } = setup();
		const ratings: ContextRating[] = [
			{ id: "e1", score: 6, reason: "meh" },
			{ id: "e2", score: 7, reason: "ok" },
		];

		const applied = await runAutoSelect(pi, ctx, units, state, {}, undefined, makeFakeSubagent(ratings, 8).factory);
		expect(applied.details).toEqual({ unselected: ["e1", "e2"], dryRun: false });
		expect(loadState(ctx).marks.e1?.mark).toBe("unselected");
		expect(loadState(ctx).marks.e2?.mark).toBe("unselected");

		const { pi: pi2, ctx: ctx2, units: units2, state: state2 } = setup();
		const dry = await runAutoSelect(pi2, ctx2, units2, state2, { dryRun: true }, undefined, makeFakeSubagent(ratings, 8).factory);
		expect(dry.details).toEqual({ unselected: ["e1", "e2"], dryRun: true });
		expect(loadState(ctx2).marks).toEqual({});
	});
});
