/**
 * Picker view-model (MVVM): all picker state and behavior — phase machine,
 * cursor/scroll, mark toggles, preview navigation, compression orchestration —
 * with zero TUI or theme knowledge. The view (view.ts) renders from this
 * object and forwards keypresses via handleInput(); services supply state
 * persistence and compression, so the whole thing is testable without a TUI.
 */

import { matchesKey } from "@earendil-works/pi-tui";

import { CompressionQueue, defaultResolveMark, type CompressionEvent } from "../compression-queue.ts";
import { MarksController, type MarkIntent } from "../marks-controller.ts";
import type { Mark, ManageContextState } from "../state.ts";
import { oneLine } from "../turn-units.ts";
import type { TurnUnit, TurnUnitMetadata } from "../turn-units.ts";
import type { CompressionService } from "../services/compression-service.ts";
import type { StateService } from "../services/state-service.ts";
import { defaultPickerConfig, type PickerConfig } from "./picker-config.ts";

export type PickerPhase = "editing" | "confirm" | "processing";

export interface LogLine {
	text: string;
	kind: "ok" | "error" | "info";
}

/** What the view should do after a keypress: re-render, or close the picker. */
export type PickerInputResult = "render" | "close";

export interface PickerViewModelDeps {
	units: TurnUnit[];
	state: ManageContextState;
	stateService: StateService;
	compressionService: CompressionService;
	/** Called when the picker is finished (esc/ctrl+c, or processing completed). */
	onClose: () => void;
	config?: Partial<PickerConfig>;
}

/** One entry from `TurnUnitMetadata.toolCalls` — used for log previews. */
type ToolCallInfo = NonNullable<TurnUnitMetadata["toolCalls"]>[number];

export class PickerViewModel {
	phase: PickerPhase = "editing";
	cursor = 0;
	scrollTop = 0;
	// Recomputed on every render() from the live terminal size so the picker
	// grows/shrinks with the window; the constructor value is just a fallback
	// for the (unlikely) case handleInput runs before the first render.
	maxVisible: number;
	previewGroupId: string | null = null;
	previewScrollTop = 0;
	previewScrollLeft = 0;
	// Cached from the last render() call so handleInput (which gets no width)
	// can clamp/step horizontal scroll against the actual box content width.
	previewContentWidth: number;
	// Also recomputed each render(), same reasoning as maxVisible above.
	previewMaxVisible = 20;
	previewMode: "compact" | "detailed" = "compact";
	// Geometry of the last rendered preview pane (line count + widest line),
	// fed back by the view so handleInput can clamp scroll against reality.
	private previewLineCount = 0;
	private previewMaxLineWidth = 0;

	// processing phase
	progressDone = 0;
	progressTotal = 0;
	log: LogLine[] = [];
	cancelled = false;

	readonly config: PickerConfig;
	readonly units: TurnUnit[];
	readonly state: ManageContextState;
	private readonly stateService: StateService;
	private readonly compressionService: CompressionService;
	private readonly onClose: () => void;
	private readonly marks: MarksController;
	private queue: CompressionQueue | null = null;

	constructor(deps: PickerViewModelDeps) {
		this.units = deps.units;
		this.state = deps.state;
		this.stateService = deps.stateService;
		this.compressionService = deps.compressionService;
		this.onClose = deps.onClose;
		this.config = { ...defaultPickerConfig, ...deps.config };
		this.marks = new MarksController(this.state, deps.units.map((u) => u.groupId));
		this.previewContentWidth = this.config.sectionRuleWidth;
		const minRows = this.config.minListRows;
		this.maxVisible = Math.max(minRows, Math.min(deps.units.length, minRows));
	}

	markOf(groupId: string): Mark {
		return this.marks.rawMark(groupId);
	}

	effectiveMark(groupId: string): Mark {
		return this.marks.effectiveMark(groupId);
	}

	setMark(groupId: string, intent: MarkIntent): void {
		this.marks.apply(groupId, intent);
	}

	countDeleted(): number {
		return this.marks.countBy("deleted");
	}

	countCompressed(): number {
		return this.marks.countBy("compressed");
	}

	currentUnit(): TurnUnit {
		return this.units[this.cursor];
	}

	/**
	 * Recompute the row budgets from the live terminal height. The view calls
	 * this at the top of every render() with the current terminal rows.
	 */
	updateLayout(terminalRows: number): void {
		const chrome = 7; // rule + title + help/legend-or-confirm + rule + status + slack, see renderEditing
		const remaining = Math.max(0, terminalRows - chrome - 1);
		const listBudget = this.previewGroupId
			? Math.max(this.config.minListBudgetWithPreview, Math.floor(remaining * this.config.listPreviewSplitRatio))
			: remaining;
		this.maxVisible = Math.max(
			Math.min(this.config.minListRows, this.units.length),
			Math.min(this.units.length, listBudget),
		);
	}

	/**
	 * Recompute the preview pane's content width / visible line count from the
	 * outer layout. The view calls this while rendering the preview box.
	 */
	updatePreviewLayout(terminalRows: number, linesSoFar: number, boxWidth: number): void {
		this.previewContentWidth = Math.max(this.config.minPreviewContentWidth, boxWidth - this.config.previewBoxChromeCols);
		this.previewMaxVisible = Math.max(
			this.config.minListBudgetWithPreview,
			terminalRows - linesSoFar - this.config.previewChromeRows,
		);
	}

	/** Called by the view after rendering the preview pane with its real geometry. */
	setPreviewGeometry(lineCount: number, maxLineWidth: number): void {
		this.previewLineCount = lineCount;
		this.previewMaxLineWidth = maxLineWidth;
	}

	private moveCursor(delta: number): void {
		this.cursor = Math.max(0, Math.min(this.units.length - 1, this.cursor + delta));
		if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
		if (this.cursor >= this.scrollTop + this.maxVisible) this.scrollTop = this.cursor - this.maxVisible + 1;
	}

	private startProcessing(): void {
		this.phase = "processing";
		const toCompress = this.units.filter((u) => this.markOf(u.groupId) === "compressed");
		this.progressTotal = toCompress.length;
		this.progressDone = 0;

		// Persist selection/deletion/unselection marks immediately — those
		// need no async work. Compression results are appended once done.
		this.stateService.save(this.state);

		void this.runCompressions(toCompress);
	}

	/** Compression worker wiring: queue events drive the log/progress; marks resolve through the queue. */
	private buildQueue(): CompressionQueue {
		return new CompressionQueue(
			(unit) => this.compressionService.compress(unit),
			(event, progress) => this.onCompressionEvent(event, progress),
			defaultResolveMark(this.state),
		);
	}

	private onCompressionEvent(event: CompressionEvent, progress: { done: number; total: number }): void {
		const preview = oneLine(event.unit.preview, this.config.logPreviewMaxWidth);
		if (event.kind === "done") {
			this.log.push({
				text: `✓ ${preview} — ${event.unit.tokenEstimate} → ~${event.compressedTokenEstimate} tok`,
				kind: "ok",
			});
		} else if (event.kind === "cancelled") {
			this.log.push({ text: `– ${preview} — cancelled`, kind: "info" });
		} else {
			this.log.push({ text: `✕ ${preview} — ${event.message}`, kind: "error" });
		}
		this.progressDone = progress.done;
		this.stateService.save(this.state);
	}

	private async runCompressions(units: TurnUnit[]): Promise<void> {
		this.queue = this.buildQueue();
		await this.queue.run(units);
		this.onClose();
	}

	/**
	 * Key dispatch. Returns "close" when the picker should dismiss (esc/ctrl+c
	 * while editing, or after processing finished); the view performs the
	 * actual TUI side effects (requestRender / done).
	 */
	handleInput(data: string): PickerInputResult {
		if (this.phase === "processing") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.cancelled = true;
				this.compressionService.cancel();
			}
			return "render";
		}

		if (this.previewGroupId) {
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "escape") ||
				matchesKey(data, "space") ||
				matchesKey(data, "ctrl+c")
			) {
				this.previewGroupId = null;
			} else if (matchesKey(data, "m")) {
				this.previewMode = this.previewMode === "compact" ? "detailed" : "compact";
			} else {
				const maxScrollTop = this.previewMaxScrollTop();
				const maxScrollLeft = this.previewMaxScrollLeft();
				if (matchesKey(data, "up")) this.previewScrollTop = Math.max(0, this.previewScrollTop - 1);
				else if (matchesKey(data, "down")) this.previewScrollTop = Math.min(maxScrollTop, this.previewScrollTop + 1);
				else if (matchesKey(data, "pageUp"))
					this.previewScrollTop = Math.max(0, this.previewScrollTop - this.previewMaxVisible);
				else if (matchesKey(data, "pageDown"))
					this.previewScrollTop = Math.min(maxScrollTop, this.previewScrollTop + this.previewMaxVisible);
				else if (matchesKey(data, "left")) this.previewGroupId = null;
				else if (matchesKey(data, "right"))
					this.previewScrollLeft = Math.min(maxScrollLeft, this.previewScrollLeft + this.config.previewHScrollStep);
				else if (matchesKey(data, "home")) this.previewScrollLeft = 0;
				else if (matchesKey(data, "end")) this.previewScrollLeft = maxScrollLeft;
			}
			return "render";
		}

		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			return "close";
		}
		if (this.phase === "confirm") {
			if (matchesKey(data, "y") || matchesKey(data, "enter")) {
				this.startProcessing();
			} else if (matchesKey(data, "n")) {
				this.phase = "editing";
			}
			return "render";
		}
		if (matchesKey(data, "enter")) {
			if (this.countDeleted() > 0 || this.countCompressed() > 0) {
				this.phase = "confirm";
			} else {
				this.startProcessing();
			}
			return "render";
		}
		if (matchesKey(data, "up")) this.moveCursor(-1);
		else if (matchesKey(data, "down")) this.moveCursor(1);
		else if (matchesKey(data, "pageUp")) this.moveCursor(-this.maxVisible);
		else if (matchesKey(data, "pageDown")) this.moveCursor(this.maxVisible);
		else if (matchesKey(data, "space")) this.setMark(this.currentUnit().groupId, "toggle-unselected");
		else if (matchesKey(data, "c")) this.setMark(this.currentUnit().groupId, "toggle-compressed");
		else if (matchesKey(data, "d")) this.setMark(this.currentUnit().groupId, "toggle-deleted");
		else if (matchesKey(data, "right")) {
			this.previewGroupId = this.currentUnit().groupId;
			this.previewScrollTop = 0;
			this.previewScrollLeft = 0;
		}

		return "render";
	}

	/** Max vertical scroll of the preview pane, given the last rendered line count. */
	private previewMaxScrollTop(): number {
		const viewportHeight = Math.max(1, Math.min(this.previewMaxVisible, this.previewLineCount));
		return Math.max(0, this.previewLineCount - viewportHeight);
	}

	/** Max horizontal scroll of the preview pane, given the last rendered widest line. */
	private previewMaxScrollLeft(): number {
		return Math.max(0, this.previewMaxLineWidth - this.previewContentWidth);
	}
}

export type { ToolCallInfo };
