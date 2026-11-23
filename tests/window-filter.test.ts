/**
 * Tests for the context-window limit (src/window-filter.ts) and its
 * consumption in the "context" hook: config normalization/resolution,
 * settings.json reading, the per-kind latest-N exclusion, arg parsing, and
 * the mark-vs-window precedence in buildFilteredMessages/handleContext.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-ai";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
	computeWindowExcluded,
	isWindowActive,
	NO_WINDOW,
	normalizeWindowConfig,
	parseWindowConfigArgs,
	readSettingsWindowConfig,
	resolveWindowConfig,
} from "../src/window-filter.ts";
import { buildFilteredMessages } from "../src/context-filter.ts";
import { handleContext } from "../src/hooks.ts";
import { emptyState, loadState, type ManageContextState } from "../src/state.ts";
import { buildTurnUnitGroups } from "../src/turn-units.ts";
import { assistantTextEntry, customEntry, makeHarness, toolCallEntry, userEntry } from "./helpers.ts";

/**
 * The spec's example conversation, newest → oldest: a t t t a u a u.
 * Returned in session order (oldest first): u8 a7 u6 a5 t4 t3 t2 a1.
 */
function exampleEntries(): SessionEntry[] {
	return [
		userEntry("u8", "u8"),
		assistantTextEntry("a7", "a7"),
		userEntry("u6", "u6"),
		assistantTextEntry("a5", "a5"),
		toolCallEntry("t4", "c4", "bash"),
		toolCallEntry("t3", "c3", "bash"),
		toolCallEntry("t2", "c2", "bash"),
		assistantTextEntry("a1", "a1"),
	];
}

function msgText(m: AgentMessage): string {
	if (typeof m.content === "string") return m.content;
	return m.content.map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? `tool:${c.id}` : c.type)).join("|");
}

function texts(entries: SessionEntry[], state: ManageContextState, excluded: Set<string>): string[] {
	return buildFilteredMessages(entries, buildTurnUnitGroups(entries), state, excluded).map(msgText);
}

describe("normalizeWindowConfig", () => {
	it("accepts a valid mode + non-negative integer window", () => {
		expect(normalizeWindowConfig({ mode: "tool", window: 10 })).toEqual({ mode: "tool", window: 10 });
		expect(normalizeWindowConfig({ mode: "assistant", window: 0 })).toEqual({ mode: "assistant", window: 0 });
		expect(normalizeWindowConfig({ mode: null, window: null })).toEqual(NO_WINDOW);
	});

	it("rejects wrong types to off / null parts", () => {
		expect(normalizeWindowConfig(undefined)).toEqual(NO_WINDOW);
		expect(normalizeWindowConfig("tool")).toEqual(NO_WINDOW);
		expect(normalizeWindowConfig({ mode: "nope", window: 5 })).toEqual({ mode: null, window: 5 });
		expect(normalizeWindowConfig({ mode: "tool", window: -1 })).toEqual({ mode: "tool", window: null });
		expect(normalizeWindowConfig({ mode: "tool", window: 2.5 })).toEqual({ mode: "tool", window: null });
		expect(normalizeWindowConfig({ mode: "tool", window: "5" })).toEqual({ mode: "tool", window: null });
	});
});

describe("isWindowActive", () => {
	it("is active only with a mode and a non-negative integer window", () => {
		expect(isWindowActive({ mode: "tool", window: 0 })).toBe(true);
		expect(isWindowActive({ mode: "user", window: 10 })).toBe(true);
		expect(isWindowActive({ mode: null, window: 10 })).toBe(false);
		expect(isWindowActive({ mode: "tool", window: null })).toBe(false);
		expect(isWindowActive(NO_WINDOW)).toBe(false);
		expect(isWindowActive({ mode: "tool", window: -1 })).toBe(false);
	});
});

describe("resolveWindowConfig", () => {
	it("inherits the settings.json default when the state has no override", () => {
		expect(resolveWindowConfig(emptyState(), { mode: "tool", window: 3 })).toEqual({ mode: "tool", window: 3 });
		expect(resolveWindowConfig(emptyState(), undefined)).toEqual(NO_WINDOW);
	});

	it("a persisted windowConfig fully replaces the settings default (even off)", () => {
		const state = { ...emptyState(), windowConfig: { mode: null, window: null } };
		expect(resolveWindowConfig(state, { mode: "tool", window: 3 })).toEqual(NO_WINDOW);
		const state2 = { ...emptyState(), windowConfig: { mode: "user", window: 7 } };
		expect(resolveWindowConfig(state2, { mode: "tool", window: 3 })).toEqual({ mode: "user", window: 7 });
	});
});

describe("readSettingsWindowConfig", () => {
	function withAgentDir(files: Record<string, string>, fn: (dir: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), "mc-settings-"));
		try {
			for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
			fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("missing file, invalid JSON, missing key, non-object → off", () => {
		withAgentDir({}, (dir) => expect(readSettingsWindowConfig(dir)).toEqual(NO_WINDOW));
		withAgentDir({ "settings.json": "not json{" }, (dir) => expect(readSettingsWindowConfig(dir)).toEqual(NO_WINDOW));
		withAgentDir({ "settings.json": "{}" }, (dir) => expect(readSettingsWindowConfig(dir)).toEqual(NO_WINDOW));
		withAgentDir({ "settings.json": "[1,2]" }, (dir) => expect(readSettingsWindowConfig(dir)).toEqual(NO_WINDOW));
		withAgentDir({ "settings.json": '{ "manage-context": "tool" }' }, (dir) =>
			expect(readSettingsWindowConfig(dir)).toEqual(NO_WINDOW),
		);
	});

	it("reads a valid manage-context block and sanitizes bad values", () => {
		withAgentDir({ "settings.json": '{ "manage-context": { "mode": "assistant", "window": 5 } }' }, (dir) =>
			expect(readSettingsWindowConfig(dir)).toEqual({ mode: "assistant", window: 5 }),
		);
		withAgentDir({ "settings.json": '{ "manage-context": { "mode": "x", "window": 5 } }' }, (dir) =>
			expect(readSettingsWindowConfig(dir).mode).toBeNull(),
		);
		withAgentDir({ "settings.json": '{ "manage-context": { "mode": "tool", "window": -2 } }' }, (dir) =>
			expect(readSettingsWindowConfig(dir)).toEqual({ mode: "tool", window: null }),
		);
	});
});

describe("computeWindowExcluded", () => {
	const groups = () => buildTurnUnitGroups(exampleEntries());

	it("inactive config excludes nothing", () => {
		expect(computeWindowExcluded(groups(), NO_WINDOW).size).toBe(0);
		expect(computeWindowExcluded(groups(), { mode: "tool", window: null }).size).toBe(0);
	});

	it("tool window 2 on 'a t t t a u a u' (newest→oldest) keeps the latest 2 tools, all a/u", () => {
		expect([...computeWindowExcluded(groups(), { mode: "tool", window: 2 })]).toEqual(["t4"]);
	});

	it("assistant window 2 keeps the latest 2 a and 2 t — 'a t t a' — and leaves u untouched", () => {
		expect([...computeWindowExcluded(groups(), { mode: "assistant", window: 2 })].sort()).toEqual(["a7", "t4"]);
	});

	it("user window counts user messages too", () => {
		// user window 2: only 2 u's exist (u6, u8) → nothing excluded beyond a/t
		expect([...computeWindowExcluded(groups(), { mode: "user", window: 2 })].sort()).toEqual(["a7", "t4"]);
		// user window 1: the older u (u8) drops as well, plus everything beyond the latest 1 a/t
		expect([...computeWindowExcluded(groups(), { mode: "user", window: 1 })].sort()).toEqual(["a5", "a7", "t3", "t4", "u8"]);
	});

	it("window 0 excludes the whole category; window ≥ count excludes nothing; exactly N excludes nothing", () => {
		expect([...computeWindowExcluded(groups(), { mode: "tool", window: 0 })].sort()).toEqual(["t2", "t3", "t4"]);
		expect(computeWindowExcluded(groups(), { mode: "tool", window: 3 }).size).toBe(0);
		expect(computeWindowExcluded(groups(), { mode: "assistant", window: 99 }).size).toBe(0);
	});

	it("never counts or excludes custom_message / bookkeeping entries", () => {
		const entries = [...exampleEntries(), customEntry("cust1")];
		const excluded = computeWindowExcluded(buildTurnUnitGroups(entries), { mode: "user", window: 0 });
		expect(excluded.has("cust1")).toBe(false);
		expect(excluded.size).toBe(8); // all u/a/t units
	});

	it("counts mid-turn tool units that have no results yet", () => {
		const excluded = computeWindowExcluded(groups(), { mode: "tool", window: 1 });
		expect([...excluded].sort()).toEqual(["t3", "t4"]); // only t2 (latest) kept
	});
});

describe("buildFilteredMessages window precedence", () => {
	const entries = exampleEntries();
	// assistant window 2 → t4 and a7 are outside the window
	const excluded = computeWindowExcluded(buildTurnUnitGroups(entries), { mode: "assistant", window: 2 });

	it("excludes out-of-window unmarked units", () => {
		const out = texts(entries, emptyState(), excluded);
		expect(out).toHaveLength(6);
		expect(out).toContain("a1");
		expect(out).toContain("tool:c2");
		expect(out).not.toContain("a7");
		expect(out).not.toContain("tool:c4");
	});

	it("an explicit selected mark pins a unit above the cap", () => {
		const state = { ...emptyState(), marks: { t4: { mark: "selected" } } };
		const out = texts(entries, state, excluded);
		expect(out).toHaveLength(7);
		expect(out).toContain("tool:c4");
	});

	it("a manual unselected inside the window stays excluded", () => {
		const state = { ...emptyState(), marks: { a1: { mark: "unselected" } } };
		const out = texts(entries, state, excluded);
		expect(out).toHaveLength(5);
		expect(out).not.toContain("a1");
	});

	it("a realized compression stays visible even outside the window", () => {
		const state = { ...emptyState(), marks: { t4: { mark: "selected", compressedText: "SUMMARY" } } };
		const out = texts(entries, state, excluded);
		expect(out).toHaveLength(7); // t4 pinned by its mark, served as the compressed replacement
		expect(out.some((t) => t.includes("SUMMARY"))).toBe(true);
	});

	it("deleted stays excluded regardless of the window", () => {
		const state = { ...emptyState(), marks: { a7: { mark: "deleted" } } };
		expect(texts(entries, state, excluded)).toHaveLength(6);
	});
});

describe("handleContext (context hook)", () => {
	it("returns undefined when no marks and no active window", () => {
		const { ctx } = makeHarness(exampleEntries());
		expect(handleContext({} as ContextEvent, ctx, NO_WINDOW)).toBeUndefined();
	});

	it("applies the window even with zero marks", () => {
		const { ctx } = makeHarness(exampleEntries());
		const result = handleContext({} as ContextEvent, ctx, { mode: "tool", window: 2 });
		expect(result?.messages).toHaveLength(7); // only t4 hidden
	});

	it("a persisted windowConfig overrides the settings.json default", () => {
		const entries = [
			...exampleEntries(),
			customEntry("state1", "manage-context", { version: 3, marks: {}, readHookEnabled: false, windowConfig: { mode: "assistant", window: 2 } }),
		];
		const { ctx } = makeHarness(entries);
		const result = handleContext({} as ContextEvent, ctx, { mode: "tool", window: 99 });
		expect(result?.messages).toHaveLength(6); // assistant window 2 won: t4 + a7 hidden
	});
});

describe("parseWindowConfigArgs (/mc config args)", () => {
	it("parses 'off' and '<mode> <N>'", () => {
		expect(parseWindowConfigArgs("off")).toEqual({ ok: true, config: NO_WINDOW });
		expect(parseWindowConfigArgs("tool 10")).toEqual({ ok: true, config: { mode: "tool", window: 10 } });
		expect(parseWindowConfigArgs(" assistant 0 ")).toEqual({ ok: true, config: { mode: "assistant", window: 0 } });
		expect(parseWindowConfigArgs("user 3")).toEqual({ ok: true, config: { mode: "user", window: 3 } });
	});

	it("rejects malformed input", () => {
		for (const bad of ["", "tool", "tool abc", "tool -1", "tool 1.5", "tool 3 extra", "bogus 3", "off 3"]) {
			expect(parseWindowConfigArgs(bad).ok).toBe(false);
		}
	});
});

describe("state migration to v3", () => {
	it("v2 snapshots keep their marks and gain version 3 without a windowConfig", () => {
		const { ctx } = makeHarness([
			customEntry("s1", "manage-context", { version: 2, marks: { g1: { mark: "unselected" } }, readHookEnabled: true }),
		]);
		const state = loadState(ctx);
		expect(state.version).toBe(3);
		expect(state.marks.g1?.mark).toBe("unselected");
		expect(state.readHookEnabled).toBe(true);
		expect(state.windowConfig).toBeUndefined();
	});

	it("v1 snapshots migrate to v3 as well", () => {
		const { ctx } = makeHarness([customEntry("s1", "manage-context", { version: 1, marks: {}, readHookEnabled: false })]);
		expect(loadState(ctx).version).toBe(3);
	});

	it("v3 snapshots keep their windowConfig", () => {
		const { ctx } = makeHarness([
			customEntry("s1", "manage-context", {
				version: 3,
				marks: {},
				readHookEnabled: false,
				windowConfig: { mode: "tool", window: 5 },
			}),
		]);
		expect(loadState(ctx).windowConfig).toEqual({ mode: "tool", window: 5 });
	});

	it("unknown versions still start fresh", () => {
		const { ctx } = makeHarness([customEntry("s1", "manage-context", { version: 99, marks: { g: { mark: "deleted" } } })]);
		expect(loadState(ctx)).toEqual(emptyState());
	});
});
