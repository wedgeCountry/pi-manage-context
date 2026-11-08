/**
 * Integration tests for the three context tools, driven through a minimal
 * in-memory stand-in for the pi runtime: appendEntry() pushes a "custom"
 * entry onto the same entries array getEntries()/buildContextEntries() read
 * from, so loadState()/saveState() round-trip exactly like they do for the
 * interactive picker. context-autoselect is tested with a dependency-injected
 * fake child-session factory, asserting the subagent's context-unselect call
 * lands in the PARENT session's state.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { UserMessage, AssistantMessage } from "@earendil-works/pi-ai";

import { buildContextSelectTool } from "../src/tools/context-select.ts";
import { buildContextUnselectTool } from "../src/tools/context-unselect.ts";
import { buildContextAutoselectTool } from "../src/tools/context-autoselect.ts";
import { runAutoSelect, type AutoSelectChildOptions, type AutoSelectSessionFactory } from "../src/tools/auto-select.ts";
import { loadState } from "../src/state.ts";
import { buildTurnUnits } from "../src/turn-units.ts";

function userEntry(id: string, text: string): SessionMessageEntry {
	const message: UserMessage = { role: "user", content: text, timestamp: 0 };
	return { type: "message", id, parentId: null, timestamp: "0", message };
}

function assistantTextEntry(id: string, text: string): SessionMessageEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
	return { type: "message", id, parentId: null, timestamp: "0", message };
}

/**
 * Minimal in-memory stand-in for the real pi runtime: appendEntry() pushes a
 * "custom" entry onto the same entries array getEntries()/buildContextEntries()
 * read from, so loadState()/saveState() round-trip exactly like they do for
 * the interactive picker in view.ts.
 */
function makeHarness(entries: SessionEntry[]): { pi: ExtensionAPI; ctx: ExtensionContext; notifies: string[] } {
	let nextId = 0;
	const notifies: string[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				id: `custom_${nextId++}`,
				parentId: null,
				timestamp: "0",
				customType,
				data,
			} as SessionEntry);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: process.cwd(),
		model: undefined,
		sessionManager: {
			getEntries: () => entries,
			buildContextEntries: () => entries,
		},
		ui: { notify: (msg: string) => notifies.push(msg) },
	} as unknown as ExtensionContext;

	return { pi, ctx, notifies };
}

describe("context-select / context-unselect tools", () => {
	it("expose the expected names and a required groupIds string-array parameter", () => {
		const { pi } = makeHarness([]);
		const select = buildContextSelectTool(pi);
		const unselect = buildContextUnselectTool(pi);

		expect(select.name).toBe("context-select");
		expect(unselect.name).toBe("context-unselect");
		for (const tool of [select, unselect]) {
			const params = tool.parameters as any;
			expect(params.type).toBe("object");
			expect(params.required).toContain("groupIds");
			expect(params.properties.groupIds.type).toBe("array");
			expect(params.properties.groupIds.items.type).toBe("string");
			expect(params.properties.textMatch).toBeUndefined();
			expect(params.properties.action).toBeUndefined();
		}
	});

	it("context-unselect marks the given groupIds unselected and persists the snapshot", async () => {
		const entries = [userEntry("e1", "Draft implementation"), userEntry("e2", "Final implementation")];
		const { pi, ctx } = makeHarness(entries);
		const tool = buildContextUnselectTool(pi);

		const result = await tool.execute("call_1", { groupIds: ["e1"] }, undefined, undefined, ctx);

		expect(result.details).toEqual(["e1"]);
		expect((result.content[0] as any).text).toContain("Marked 1 unit(s) as unselected");
		expect(loadState(ctx).marks.e1?.mark).toBe("unselected");
		expect(loadState(ctx).marks.e2).toBeUndefined();
	});

	it("context-select re-selects a previously unselected unit by groupId", async () => {
		const entries = [userEntry("e1", "Please refactor the auth module"), userEntry("e2", "hi there")];
		const { pi, ctx } = makeHarness(entries);
		const unselect = buildContextUnselectTool(pi);
		const select = buildContextSelectTool(pi);

		await unselect.execute("call_1", { groupIds: ["e1"] }, undefined, undefined, ctx);
		const reselect = await select.execute("call_2", { groupIds: ["e1"] }, undefined, undefined, ctx);

		expect(reselect.details).toEqual(["e1"]);
		expect(loadState(ctx).marks.e1?.mark).toBe("selected");
	});

	it("an empty groupIds array is a no-op: nothing persisted, no notification", async () => {
		const entries = [userEntry("e1", "hi there")];
		const { pi, ctx, notifies } = makeHarness(entries);
		const tool = buildContextUnselectTool(pi);
		const entriesBefore = entries.length;

		const result = await tool.execute("call_1", { groupIds: [] }, undefined, undefined, ctx);

		expect(result.details).toEqual([]);
		expect((result.content[0] as any).text).toMatch(/no groupIds given/i);
		expect(entries.length).toBe(entriesBefore); // no snapshot appended
		expect(loadState(ctx).marks).toEqual({});
		expect(notifies).toHaveLength(0);
	});

	it("unknown groupIds are rejected: not applied, reported as not matched", async () => {
		const entries = [userEntry("e1", "hi there")];
		const { pi, ctx } = makeHarness(entries);
		const tool = buildContextUnselectTool(pi);

		const result = await tool.execute("call_1", { groupIds: ["bogus"] }, undefined, undefined, ctx);

		expect(result.details).toEqual([]);
		expect((result.content[0] as any).text).toMatch(/no turn units matched/i);
		expect((result.content[0] as any).text).toContain("bogus");
		expect(loadState(ctx).marks).toEqual({});
	});

	it("notifies the user only when a mark actually changed", async () => {
		const entries = [userEntry("e1", "Draft implementation")];
		const { pi, ctx, notifies } = makeHarness(entries);
		const tool = buildContextUnselectTool(pi);

		await tool.execute("call_1", { groupIds: ["e1"] }, undefined, undefined, ctx);
		await tool.execute("call_2", { groupIds: [] }, undefined, undefined, ctx);
		await tool.execute("call_3", { groupIds: ["nope"] }, undefined, undefined, ctx);

		expect(notifies).toHaveLength(1);
		expect(notifies[0]).toContain("context-unselect");
		expect(notifies[0]).toMatch(/Marked 1 unit\(s\) as unselected/);
	});
});

describe("context-autoselect", () => {
	it("exposes focus and dryRun optional parameters", () => {
		const { pi } = makeHarness([]);
		const tool = buildContextAutoselectTool(pi);
		const params = tool.parameters as any;

		expect(tool.name).toBe("context-autoselect");
		expect(params.properties.focus.type).toBe("string");
		expect(params.properties.dryRun.type).toBe("boolean");
		expect(params.required ?? []).toEqual([]);
	});

	/** Fake child session: runs the captured child tool once, like the subagent would. */
	function makeFakeFactory(childGroupIds: string[]) {
		let captured: AutoSelectChildOptions | undefined;
		let task = "";
		const factory: AutoSelectSessionFactory = async (options) => {
			captured = options;
			return {
				prompt: async (t: string) => {
					task = t;
					const childTool = options.customTools[0];
					await childTool.execute("child-call-1", { groupIds: childGroupIds }, undefined, undefined, {} as any);
				},
				abort: vi.fn(),
				dispose: vi.fn(),
				subscribe: () => () => {},
			};
		};
		return { factory, getCaptured: () => captured, getTask: () => task };
	}

	function setup() {
		const entries: SessionEntry[] = [
			userEntry("e1", "old brainstorming about a side project"),
			assistantTextEntry("e2", "Sure, here are ideas..."),
			userEntry("e3", "now fix the login bug"),
		];
		const harness = makeHarness(entries);
		const units = buildTurnUnits(entries);
		const state = loadState(harness.ctx);
		return { ...harness, units, state };
	}

	it("gives the subagent context-unselect as its ONLY tool and lands its call in the parent state", async () => {
		const { pi, ctx, units, state } = setup();
		const { factory, getCaptured, getTask } = makeFakeFactory(["e1", "bogus-id"]);

		const result = await runAutoSelect(pi, ctx, units, state, { focus: "fixing the login bug" }, undefined, factory);

		const captured = getCaptured()!;
		expect(captured.customTools).toHaveLength(1);
		expect(captured.customTools[0].name).toBe("context-unselect");
		expect(getTask()).toContain("fixing the login bug");
		expect(getTask()).toContain('"groupId": "e1"');

		// The child's call mutated the PARENT session's state; "bogus-id" was rejected.
		expect(result.details).toEqual({ unselected: ["e1"], dryRun: false });
		expect(loadState(ctx).marks.e1?.mark).toBe("unselected");
		expect(loadState(ctx).marks["bogus-id"]).toBeUndefined();
		expect((result.content[0] as any).text).toContain("unselected 1 unit(s)");
	});

	it("never offers the latest user unit to the subagent", async () => {
		const { pi, ctx, units, state } = setup();
		const { factory, getTask } = makeFakeFactory([]);

		await runAutoSelect(pi, ctx, units, state, {}, undefined, factory);

		expect(getTask()).toContain('"groupId": "e1"');
		expect(getTask()).toContain('"groupId": "e2"');
		expect(getTask()).not.toContain('"groupId": "e3"');
	});

	it("dryRun reports the chosen ids without persisting anything", async () => {
		const { pi, ctx, units, state } = setup();
		const { factory } = makeFakeFactory(["e1"]);

		const result = await runAutoSelect(pi, ctx, units, state, { dryRun: true }, undefined, factory);

		expect(result.details).toEqual({ unselected: ["e1"], dryRun: true });
		expect((result.content[0] as any).text).toMatch(/dry run/i);
		expect(loadState(ctx).marks).toEqual({}); // nothing persisted
	});

	it("short-circuits without spawning a subagent when only the latest user turn exists", async () => {
		const entries = [userEntry("e1", "the only message")];
		const { pi, ctx, notifies } = makeHarness(entries);
		const factory: AutoSelectSessionFactory = async () => {
			throw new Error("subagent must not be spawned");
		};

		const units = buildTurnUnits(entries);
		const state = loadState(ctx);
		const result = await runAutoSelect(pi, ctx, units, state, {}, undefined, factory);

		expect(result.details).toEqual({ unselected: [], dryRun: false });
		expect((result.content[0] as any).text).toMatch(/no turn units available/i);
		expect(notifies).toHaveLength(0);
	});

	it("propagates the parent abort signal to the child session", async () => {
		const { pi, ctx, units, state } = setup();
		const abort = vi.fn();
		const controller = new AbortController();
		const factory: AutoSelectSessionFactory = async () => ({
			prompt: async () => {
				controller.abort();
			},
			abort,
			dispose: () => {},
			subscribe: () => () => {},
		});

		await runAutoSelect(pi, ctx, units, state, {}, controller.signal, factory);

		expect(abort).toHaveBeenCalled();
	});
});
