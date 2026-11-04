/**
 * Tests for the extracted, TUI-free picker logic: mark transitions
 * (MarksController), mark-status reporting (mark-status), state migration
 * and mark GC (state), and compression orchestration (CompressionQueue).
 */
import { describe, expect, it, vi } from "vitest";
import { MarksController } from "../src/marks-controller.ts";
import { markStatus, describeMark } from "../src/mark-status.ts";
import { emptyState, pruneMarks, type ManageContextState } from "../src/state.ts";
import { CompressionQueue, defaultResolveMark } from "../src/compression-queue.ts";
import type { TurnUnit } from "../src/turn-units.ts";

function makeUnit(groupId: string): TurnUnit {
	return {
		groupId,
		kind: "user",
		entryIds: [groupId],
		anchorEntry: {} as TurnUnit["anchorEntry"],
		resultEntries: [],
		timestamp: "0",
		preview: groupId,
		tokenEstimate: 10,
		metadata: { heading: groupId, type: "user_message", timestamp: "0", summary: groupId },
	};
}

function stateWith(marks: ManageContextState["marks"]): ManageContextState {
	return { ...emptyState(), marks };
}

describe("MarksController", () => {
	it("toggles a mark on, then back off with the same intent", () => {
		const state = stateWith({});
		const marks = new MarksController(state, ["u1"]);

		expect(marks.apply("u1", "toggle-deleted")).toBe("deleted");
		expect(state.marks.u1?.mark).toBe("deleted");
		expect(marks.apply("u1", "toggle-deleted")).toBe("selected");
		expect(state.marks.u1?.mark).toBe("selected");
	});

	it("replaces a different mark instead of toggling it off", () => {
		const state = stateWith({ u1: { mark: "unselected" } });
		const marks = new MarksController(state, ["u1"]);

		expect(marks.apply("u1", "toggle-compressed")).toBe("compressed");
		expect(state.marks.u1?.mark).toBe("compressed");
	});

	it("keeps a realized compression reading as compressed until overridden by another mark", () => {
		const state = stateWith({ u1: { mark: "selected", compressedText: "summary" } });
		const marks = new MarksController(state, ["u1"]);

		expect(marks.effectiveMark("u1")).toBe("compressed");
		// pressing c again reverts the raw mark to "selected" but the
		// realized compressedText stays — the unit still reads as compressed
		// (buildFilteredMessages keeps serving the summary).
		marks.apply("u1", "toggle-compressed");
		expect(marks.effectiveMark("u1")).toBe("compressed");
		// an explicit unselect/delete override wins over the lingering text
		expect(marks.apply("u1", "toggle-deleted")).toBe("deleted");
	});

	it("counts only the managed groupIds, not every stored mark", () => {
		const state = stateWith({ u1: { mark: "deleted" }, u9: { mark: "deleted" } });
		const marks = new MarksController(state, ["u1"]);

		expect(marks.countBy("deleted")).toBe(1);
	});
});

describe("markStatus", () => {
	it("defaults to selected with no stored info", () => {
		const status = markStatus(emptyState(), "u1");
		expect(status.effective).toBe("selected");
		expect(status.raw).toBe("selected");
		expect(status.info).toBeUndefined();
	});

	it("reads realized compressions as compressed regardless of raw mark", () => {
		const state = stateWith({ u1: { mark: "selected", compressedText: "sum" } });
		const status = markStatus(state, "u1");
		expect(status.raw).toBe("selected");
		expect(status.effective).toBe("compressed");
		expect(status.label).toBe("[compressed]");
	});

	it("exposes per-mark glyphs and labels", () => {
		expect(markStatus(stateWith({ u1: { mark: "unselected" } }), "u1").symbol).toBe("○");
		expect(markStatus(stateWith({ u1: { mark: "deleted" } }), "u1").label).toBe("[deleted]");
		expect(markStatus(stateWith({ u1: { mark: "selected" } }), "u1").label).toBe("");
	});

	it("describeMark carries tokenEstimate-neutral status for a unit", () => {
		const state = stateWith({ u1: { mark: "unselected" } });
		expect(describeMark(makeUnit("u1"), state).effective).toBe("unselected");
	});
});

describe("state migration + GC", () => {
	it("migrates a v1 snapshot to the current version with marks intact", async () => {
		const { loadState } = await import("../src/state.ts");
		const v1 = { version: 1, marks: { u1: { mark: "deleted" } }, readHookEnabled: true };
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "custom", customType: "manage-context", data: v1 }],
			},
		} as never;
		const state = loadState(ctx);
		expect(state.version).toBe(2);
		expect(state.marks.u1?.mark).toBe("deleted");
		expect(state.readHookEnabled).toBe(true);
	});

	it("discards unknown future versions instead of misapplying them", async () => {
		const { loadState } = await import("../src/state.ts");
		const ctx = {
			sessionManager: {
				getEntries: () => [{ type: "custom", customType: "manage-context", data: { version: 99, marks: { x: "wrong-shape" } } }],
			},
		} as never;
		expect(loadState(ctx)).toEqual(emptyState());
	});

	it("prunes marks whose groupIds no longer exist in the session", () => {
		const state = stateWith({ u1: { mark: "deleted" }, u2: { mark: "unselected" } });
		const removed = pruneMarks(state, new Set(["u1"]));
		expect(removed).toBe(1);
		expect(state.marks).toEqual({ u1: { mark: "deleted" } });
	});
});

describe("CompressionQueue", () => {
	it("resolves marks for successful compressions and reports progress", async () => {
		const state = stateWith({ u1: { mark: "compressed" }, u2: { mark: "compressed" } });
		const events: string[] = [];
		const units = [makeUnit("u1"), makeUnit("u2")];
		const queue = new CompressionQueue(
			async (unit) => `summary of ${unit.groupId}`,
			(event, progress) => events.push(`${event.kind}:${event.unit.groupId}@${progress.done}/${progress.total}`),
			defaultResolveMark(state),
		);

		await queue.run(units);

		expect(events).toEqual(["done:u1@1/2", "done:u2@2/2"]);
		expect(state.marks.u1?.mark).toBe("selected");
		expect(state.marks.u1?.compressedText).toBe("summary of u1");
		expect(state.marks.u1?.originalTokenEstimate).toBe(10);
		expect(state.marks.u2?.compressedText).toBe("summary of u2");
	});

	it("leaves the mark untouched on failure so the filter falls back to originals", async () => {
		const state = stateWith({ u1: { mark: "compressed" } });
		const units = [makeUnit("u1")];
		const queue = new CompressionQueue(
			async () => {
				throw new Error("boom");
			},
			(event) => events.push(event.kind),
			defaultResolveMark(state),
		);
		const events: string[] = [];

		await queue.run(units);

		expect(events).toEqual(["error"]);
		expect(state.marks.u1?.mark).toBe("compressed");
		expect(state.marks.u1?.compressedText).toBeUndefined();
	});

	it("stops starting new compressions once cancelled", async () => {
		const state = stateWith({});
		const units = [makeUnit("u1"), makeUnit("u2"), makeUnit("u3")];
		const compress = vi.fn(async (unit: TurnUnit) => {
			if (unit.groupId === "u2") throw new Error("aborted mid-queue");
			return "ok";
		});
		const queue = new CompressionQueue(compress, () => {}, defaultResolveMark(state));

		const running = queue.run(units);
		queue.cancel();
		await running;

		// cancel() lands during the first await: u1 finishes, u2/u3 never start
		expect(compress).toHaveBeenCalledTimes(1);
	});
});
