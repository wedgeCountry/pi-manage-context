/**
 * TUI component for the /manage_context picker: a scrollable list of turn
 * units with per-row marks, an inline content preview, and a progress view
 * while queued compressions run.
 */

import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

import { compressUnit, renderUnitForCompression, resolveCompressionModel } from "./compression.js";
import { saveState } from "./state.js";
import type { Mark, ManageContextState } from "./state.js";
import { oneLine } from "./turn-units.js";
import type { TurnUnit } from "./turn-units.js";

interface LogLine {
	text: string;
	kind: "ok" | "error" | "info";
}

export class ManageContextView implements Component {
	private phase: "editing" | "confirm" | "processing" = "editing";
	private cursor = 0;
	private scrollTop = 0;
	private readonly maxVisible: number;
	private previewGroupId: string | null = null;
	private previewScrollTop = 0;
	private previewScrollLeft = 0;
	// Cached from the last render() call so handleInput (which gets no width)
	// can clamp/step horizontal scroll against the actual box content width.
	private previewContentWidth = 40;
	private readonly previewMaxVisible = 20;
	private readonly previewHScrollStep = 4;

	// processing phase
	private progressDone = 0;
	private progressTotal = 0;
	private log: LogLine[] = [];
	private cancelled = false;
	private abortController = new AbortController();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly units: TurnUnit[],
		private readonly state: ManageContextState,
		private readonly ctx: ExtensionCommandContext,
		private readonly pi: ExtensionAPI,
		private readonly done: (result: void) => void,
	) {
		this.maxVisible = Math.max(5, Math.min(units.length, 20));
	}

	invalidate(): void {}

	private markOf(groupId: string): Mark {
		return this.state.marks[groupId]?.mark ?? "selected";
	}

	/**
	 * Display mark: a realized compression resets `mark` back to "selected"
	 * (see runCompressions), but the row should keep reading as "compressed"
	 * until the user explicitly overrides it (unselect/delete/re-queue).
	 */
	private effectiveMark(groupId: string): Mark {
		const raw = this.markOf(groupId);
		if (raw === "selected" && this.state.marks[groupId]?.compressedText) return "compressed";
		return raw;
	}

	private setMark(groupId: string, target: Mark): void {
		const current = this.markOf(groupId);
		const existing = this.state.marks[groupId];
		if (current === target) {
			// pressing the same key again reverts to "selected"
			this.state.marks[groupId] = { ...existing, mark: "selected" };
		} else {
			this.state.marks[groupId] = { ...existing, mark: target };
		}
	}

	private glyphFor(mark: Mark): string {
		switch (mark) {
			case "selected":
				return this.theme.fg("success", "●");
			case "unselected":
				return this.theme.fg("dim", "○");
			case "compressed":
				return this.theme.fg("warning", "▤");
			case "deleted":
				return this.theme.fg("error", "✕");
		}
	}

	private labelFor(unit: TurnUnit): string {
		const info = this.state.marks[unit.groupId];
		if (info?.compressedText) {
			return `compressed (${info.originalTokenEstimate ?? unit.tokenEstimate} → ${info.compressedTokenEstimate ?? "?"} tok)`;
		}
		return unit.preview;
	}

	render(width: number): string[] {
		if (this.phase === "processing") return this.renderProcessing(width);
		return this.renderEditing(width);
	}

	private countDeleted(): number {
		return this.units.filter((u) => this.markOf(u.groupId) === "deleted").length;
	}

	private countCompressed(): number {
		return this.units.filter((u) => this.markOf(u.groupId) === "compressed").length;
	}

	private renderEditing(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.bold(this.theme.fg("accent", "Manage context")));
		if (this.phase === "confirm") {
			const nDeleted = this.countDeleted();
			const nCompressed = this.countCompressed();
			if (nDeleted > 0) {
				lines.push(
					this.theme.fg(
						"error",
						`Permanently delete ${nDeleted} ${nDeleted === 1 ? "entry" : "entries"}? This cannot be undone.`,
					),
				);
			}
			if (nCompressed > 0) {
				lines.push(
					this.theme.fg(
						"warning",
						`Compact ${nCompressed} ${nCompressed === 1 ? "entry" : "entries"} into ${nCompressed === 1 ? "a summary" : "summaries"}?`,
					),
				);
			}
			lines.push(this.theme.fg("muted", "y/enter confirm   n/esc cancel"));
		} else {
			lines.push(
				this.theme.fg(
					"muted",
					"↑/↓ move   space select/unselect   c compress   d delete   enter preview   esc apply   ctrl+c cancel",
				),
			);
		}
		lines.push("");

		const start = this.scrollTop;
		const end = Math.min(this.units.length, start + this.maxVisible);
		for (let i = start; i < end; i++) {
			const unit = this.units[i];
			const isCursor = i === this.cursor;
			const glyph = this.glyphFor(this.effectiveMark(unit.groupId));
			const tokens = this.theme.fg("dim", `${unit.tokenEstimate}t`);
			const prefix = isCursor ? this.theme.fg("accent", "❯ ") : "  ";
			const label = this.labelFor(unit);
			const text = isCursor ? this.theme.bold(label) : label;
			lines.push(`${prefix}${glyph} ${text}  ${tokens}`.slice(0, Math.max(10, width)));
		}
		lines.push(this.theme.fg("dim", `showing ${start + 1}-${end} of ${this.units.length}`));

		if (this.previewGroupId) {
			const unit = this.units.find((u) => u.groupId === this.previewGroupId);
			if (unit) {
				lines.push("");

				// The preview is rendered as its own bordered window (not just
				// text flowing at the outer TUI width) so the scrollbar has a
				// track to sit in that clearly belongs to the preview, not the
				// picker around it.
				const boxWidth = Math.max(20, width);
				const contentWidth = Math.max(4, boxWidth - 5); // "│ " + content + " " + scrollbar col + "│"
				this.previewContentWidth = contentWidth;

				const fullLines = this.previewLines();
				const viewportHeight = Math.max(1, Math.min(this.previewMaxVisible, fullLines.length));
				const maxScrollTop = Math.max(0, fullLines.length - viewportHeight);
				const scrollTop = Math.min(this.previewScrollTop, maxScrollTop);
				const visibleLines = fullLines.slice(scrollTop, scrollTop + viewportHeight);
				const showVScrollbar = fullLines.length > viewportHeight;
				const vThumb = this.scrollbarThumb(viewportHeight, fullLines.length, scrollTop);

				const maxLineWidth = fullLines.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
				const maxScrollLeft = Math.max(0, maxLineWidth - contentWidth);
				const scrollLeft = Math.min(this.previewScrollLeft, maxScrollLeft);
				const showHScrollbar = maxLineWidth > contentWidth;
				const hThumb = this.scrollbarThumb(contentWidth, maxLineWidth, scrollLeft);

				const border = this.theme.fg("accent", "│");
				lines.push(this.theme.fg("accent", `┌─ preview ${"─".repeat(Math.max(0, boxWidth - 12))}┐`));
				for (let i = 0; i < viewportHeight; i++) {
					const raw = visibleLines[i] ?? "";
					const windowed = sliceByColumn(raw, scrollLeft, contentWidth);
					const content = this.theme.fg("text", truncateToWidth(windowed, contentWidth, "", true));
					const onThumb = showVScrollbar && i >= vThumb.start && i < vThumb.start + vThumb.size;
					const scrollChar = showVScrollbar ? (onThumb ? "█" : "│") : " ";
					const scrollColored = this.theme.fg(onThumb ? "accent" : "dim", scrollChar);
					lines.push(`${border} ${content} ${scrollColored}${border}`);
				}
				if (showHScrollbar) {
					let track = "";
					for (let c = 0; c < contentWidth; c++) {
						const onThumb = c >= hThumb.start && c < hThumb.start + hThumb.size;
						track += this.theme.fg(onThumb ? "accent" : "dim", onThumb ? "█" : "─");
					}
					lines.push(`${border} ${track} ${this.theme.fg("dim", " ")}${border}`);
				}
				lines.push(this.theme.fg("accent", `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`));

				const scrollHints: string[] = [];
				if (showVScrollbar) scrollHints.push("↑/↓ scroll  pgup/pgdn page");
				if (showHScrollbar) scrollHints.push("←/→ scroll  home/end jump");
				const hint = scrollHints.length > 0 ? `   ${scrollHints.join("   ")}` : "";
				lines.push(
					this.theme.fg("dim", `line ${scrollTop + 1}-${scrollTop + viewportHeight} of ${fullLines.length}${hint}`),
				);
				lines.push(this.theme.fg("dim", "enter to close preview"));
			}
		}
		return lines;
	}

	private previewLines(): string[] {
		const unit = this.units.find((u) => u.groupId === this.previewGroupId);
		if (!unit) return [];
		const compressedText = this.state.marks[unit.groupId]?.compressedText;
		const full = compressedText || renderUnitForCompression(unit) || unit.preview;
		return full.split("\n");
	}

	/** Shared thumb-geometry math for both the vertical and horizontal scrollbars. */
	private scrollbarThumb(viewportSize: number, totalSize: number, scrollPos: number): { start: number; size: number } {
		if (totalSize <= viewportSize) return { start: 0, size: viewportSize };
		const size = Math.max(1, Math.round((viewportSize / totalSize) * viewportSize));
		const maxScrollPos = totalSize - viewportSize;
		const start = maxScrollPos === 0 ? 0 : Math.round((scrollPos / maxScrollPos) * (viewportSize - size));
		return { start, size };
	}

	private renderProcessing(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.bold(this.theme.fg("accent", "Applying changes")));
		const barWidth = Math.max(10, Math.min(40, width - 10));
		const filled =
			this.progressTotal === 0 ? barWidth : Math.round((this.progressDone / this.progressTotal) * barWidth);
		const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barWidth - filled));
		lines.push(`[${bar}] ${this.progressDone}/${this.progressTotal}`);
		lines.push("");
		for (const entry of this.log.slice(-15)) {
			const color = entry.kind === "ok" ? "success" : entry.kind === "error" ? "error" : "muted";
			lines.push(this.theme.fg(color, entry.text));
		}
		if (this.progressDone >= this.progressTotal) {
			lines.push("");
			lines.push(this.theme.fg("dim", "done — closing…"));
		} else if (this.cancelled) {
			lines.push("");
			lines.push(this.theme.fg("dim", "cancelling…"));
		} else {
			lines.push("");
			lines.push(this.theme.fg("dim", "esc to cancel"));
		}
		return lines;
	}

	handleInput(data: string): void {
		if (this.phase === "processing") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.cancelled = true;
				this.abortController.abort();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		if (this.phase === "confirm") {
			if (matchesKey(data, "y") || matchesKey(data, "enter")) {
				this.startProcessing();
			} else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
				this.phase = "editing";
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.countDeleted() > 0 || this.countCompressed() > 0) {
				this.phase = "confirm";
				this.tui.requestRender();
			} else {
				this.startProcessing();
			}
			return;
		}
		if (this.previewGroupId) {
			if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
				this.previewGroupId = null;
			} else {
				const fullLines = this.previewLines();
				const viewportHeight = Math.max(1, Math.min(this.previewMaxVisible, fullLines.length));
				const maxScrollTop = Math.max(0, fullLines.length - viewportHeight);
				const maxLineWidth = fullLines.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
				const maxScrollLeft = Math.max(0, maxLineWidth - this.previewContentWidth);
				if (matchesKey(data, "up")) this.previewScrollTop = Math.max(0, this.previewScrollTop - 1);
				else if (matchesKey(data, "down")) this.previewScrollTop = Math.min(maxScrollTop, this.previewScrollTop + 1);
				else if (matchesKey(data, "pageUp"))
					this.previewScrollTop = Math.max(0, this.previewScrollTop - viewportHeight);
				else if (matchesKey(data, "pageDown"))
					this.previewScrollTop = Math.min(maxScrollTop, this.previewScrollTop + viewportHeight);
				else if (matchesKey(data, "left"))
					this.previewScrollLeft = Math.max(0, this.previewScrollLeft - this.previewHScrollStep);
				else if (matchesKey(data, "right"))
					this.previewScrollLeft = Math.min(maxScrollLeft, this.previewScrollLeft + this.previewHScrollStep);
				else if (matchesKey(data, "home")) this.previewScrollLeft = 0;
				else if (matchesKey(data, "end")) this.previewScrollLeft = maxScrollLeft;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) this.moveCursor(-1);
		else if (matchesKey(data, "down")) this.moveCursor(1);
		else if (matchesKey(data, "pageUp")) this.moveCursor(-this.maxVisible);
		else if (matchesKey(data, "pageDown")) this.moveCursor(this.maxVisible);
		else if (matchesKey(data, "space")) this.setMark(this.currentUnit().groupId, "unselected");
		else if (matchesKey(data, "c")) this.setMark(this.currentUnit().groupId, "compressed");
		else if (matchesKey(data, "d")) this.setMark(this.currentUnit().groupId, "deleted");
		else if (matchesKey(data, "enter")) {
			this.previewGroupId = this.currentUnit().groupId;
			this.previewScrollTop = 0;
			this.previewScrollLeft = 0;
		}

		this.tui.requestRender();
	}

	private currentUnit(): TurnUnit {
		return this.units[this.cursor];
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
		this.tui.requestRender();

		// Persist selection/deletion/unselection marks immediately — those
		// need no async work. Compression results are appended once done.
		saveState(this.pi, this.state);

		void this.runCompressions(toCompress);
	}

	private async runCompressions(units: TurnUnit[]): Promise<void> {
		const model = await resolveCompressionModel(this.ctx, this.state);
		for (const unit of units) {
			if (this.cancelled) break;
			if (!model) {
				this.log.push({ text: `✕ ${unit.preview} — no model available`, kind: "error" });
				this.progressDone++;
				this.tui.requestRender();
				continue;
			}
			try {
				const compressedText = await compressUnit(unit, model, this.ctx, this.abortController.signal);
				const info = this.state.marks[unit.groupId] ?? { mark: "compressed" as Mark };
				// Compaction succeeded and is now baked into context via
				// compressedText (see buildFilteredMessages); the pending
				// "compress this" mark is resolved, so the entry goes back to
				// the normal "selected" state in the menu.
				info.mark = "selected";
				info.compressedText = compressedText;
				info.compressedAt = new Date().toISOString();
				info.originalTokenEstimate = unit.tokenEstimate;
				info.compressedTokenEstimate = Math.ceil(compressedText.length / 4);
				this.state.marks[unit.groupId] = info;
				this.log.push({
					text: `✓ ${oneLine(unit.preview, 60)} — ${unit.tokenEstimate} → ~${info.compressedTokenEstimate} tok`,
					kind: "ok",
				});
			} catch (err) {
				if (this.cancelled) {
					this.log.push({ text: `– ${oneLine(unit.preview, 60)} — cancelled`, kind: "info" });
				} else {
					const message = err instanceof Error ? err.message : String(err);
					this.log.push({ text: `✕ ${oneLine(unit.preview, 60)} — ${message}`, kind: "error" });
				}
				// leave the mark as-is (still "compressed" but with no
				// compressedText); buildFilteredMessages() falls back to the
				// original content whenever compressedText is missing.
			}
			this.progressDone++;
			saveState(this.pi, this.state);
			this.tui.requestRender();
		}
		this.done();
	}
}
