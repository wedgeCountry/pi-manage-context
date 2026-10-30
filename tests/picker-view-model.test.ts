/**
 * Tests for the picker view-model (MVVM): the phase machine, key dispatch,
 * mark toggles, and compression orchestration — all without a TUI, by
 * injecting fake state/compression services. Keys are sent as the raw
 * terminal bytes matchesKey() expects.
 */
import { describe, expect, it, vi } from "vitest";
import { PickerViewModel } from "../src/picker/picker-view-model.ts";
import type { CompressionService } from "../src/services/compression-service.ts";
import type { StateService } from "../src/services/state-service.ts";
import { emptyState, type ManageContextState } from "../src/state.ts";
import type { TurnUnit } from "../src/turn-units.ts";

const K = {
	escape: "\x1b",
	ctrlC: "\x03",
	enter: "\r",
	space: " ",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
};

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

function makeDeps() {
	const units = [makeUnit("u1"), makeUnit("u2")];
	const state: ManageContextState = emptyState();
	const save = vi.fn();
	const stateService: StateService = { load: () => state, save };
	const compress = vi.fn(async () => "summary");
	const cancel = vi.fn();
	const compressionService: CompressionService = { compress, cancel };
	const onClose = vi.fn();
	const vm = new PickerViewModel({ units, state, stateService, compressionService, onClose });
	return { vm, units, state, save, compress, cancel, onClose };
}

describe("PickerViewModel", () => {
	it("esc while editing closes the picker", () => {
		const { vm } = makeDeps();
		expect(vm.handleInput(K.escape)).toBe("close");
	});

	it("space toggles the cursor unit's mark and cursor keys move within bounds", () => {
		const { vm, state } = makeDeps();
		vm.handleInput(K.space);
		expect(state.marks.u1?.mark).toBe("unselected");
		vm.handleInput(K.space);
		expect(state.marks.u1?.mark).toBe("selected");

		vm.handleInput(K.down);
		expect(vm.cursor).toBe(1);
		vm.handleInput(K.down);
		expect(vm.cursor).toBe(1); // clamped at the end
		vm.handleInput(K.up);
		expect(vm.cursor).toBe(0);
		vm.handleInput(K.up);
		expect(vm.cursor).toBe(0); // clamped at the start
	});

	it("enter with pending marks asks for confirmation; y runs processing and persists state", async () => {
		const { vm, state, save, onClose } = makeDeps();
		vm.handleInput("d");
		expect(vm.phase).toBe("editing");
		vm.handleInput(K.enter);
		expect(vm.phase).toBe("confirm");
		vm.handleInput("y");
		expect(vm.phase).toBe("processing");
		expect(state.marks.u1?.mark).toBe("deleted");
		expect(save).toHaveBeenCalled();
		await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	it("enter with no pending marks goes straight to processing", async () => {
		const { vm, onClose } = makeDeps();
		vm.handleInput(K.enter);
		expect(vm.phase).toBe("processing");
		await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	it("n in confirm phase returns to editing without applying", () => {
		const { vm, state } = makeDeps();
		vm.handleInput("c");
		vm.handleInput(K.enter);
		expect(vm.phase).toBe("confirm");
		vm.handleInput("n");
		expect(vm.phase).toBe("editing");
		expect(state.marks.u1?.mark).toBe("compressed");
	});

	it("runs queued compressions through the compression service and records the result", async () => {
		const { vm, state, compress, save, onClose } = makeDeps();
		vm.handleInput("c");
		vm.handleInput(K.enter);
		vm.handleInput("y");
		await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(compress).toHaveBeenCalledTimes(1);
		expect(state.marks.u1?.compressedText).toBe("summary");
		expect(state.marks.u1?.mark).toBe("selected");
		expect(save.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("esc during processing cancels the compression service", async () => {
		const { vm, cancel, onClose } = makeDeps();
		vm.handleInput(K.enter); // straight to processing (no marks)
		expect(vm.phase).toBe("processing");
		const result = vm.handleInput(K.escape);
		expect(result).toBe("render");
		expect(vm.cancelled).toBe(true);
		expect(cancel).toHaveBeenCalled();
		await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	it("right opens the preview for the cursor unit; enter closes it again", () => {
		const { vm } = makeDeps();
		vm.handleInput(K.right);
		expect(vm.previewGroupId).toBe("u1");
		vm.handleInput(K.enter);
		expect(vm.previewGroupId).toBeNull();
	});
});
