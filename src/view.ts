/**
 * TUI component for the /manage_context picker (the "V" in MVVM): renders
 * the PickerViewModel's state and forwards keypresses to it. All state,
 * mark logic, and compression orchestration live in picker/picker-view-model.ts;
 * this file only knows how to turn view-model state into themed lines.
 */

import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { Mark } from "./state.ts";
import { oneLine } from "./turn-units.ts";
import type { TurnUnit, TurnUnitMetadata } from "./turn-units.ts";
import type { PickerViewModel } from "./picker/picker-view-model.ts";

/** One entry from `TurnUnitMetadata.toolCalls` — kept local since it's only used for display formatting. */
type ToolCallInfo = NonNullable<TurnUnitMetadata["toolCalls"]>[number];

export class ManageContextView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly vm: PickerViewModel;
	private readonly done: (result: void) => void;

	constructor(tui: TUI, theme: Theme, vm: PickerViewModel, done: (result: void) => void) {
		this.tui = tui;
		this.theme = theme;
		this.vm = vm;
		this.done = done;
	}

	invalidate(): void {}

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

	/** Short, role-colored tag echoing the chat-transcript styling /tree uses ("user:", "assistant:", …). */
	private kindTag(unit: TurnUnit): string {
		switch (unit.kind) {
			case "user":
				return this.theme.fg("accent", "user");
			case "assistant_text":
				return this.theme.fg("success", "assistant");
			case "assistant_tool":
				return this.theme.fg("toolTitle", "tools");
			case "custom_message":
				return this.theme.fg("customMessageLabel", unit.metadata.type.replace(/^custom_/, ""));
		}
	}

	/** Compact "name(args)" summary for one tool call, in the spirit of /tree's per-tool formatting. */
	private summarizeToolArgs(name: string, args: Record<string, unknown>): string {
		const path = args.path ?? args.file_path;
		if (typeof path === "string" && (name === "read" || name === "write" || name === "edit" || name === "ls")) return path;
		if (name === "bash" && typeof args.command === "string") return oneLine(String(args.command), this.vm.config.toolArgsMaxWidth);
		if (name === "grep" && typeof args.pattern === "string") return `/${args.pattern}/`;
		try {
			return oneLine(JSON.stringify(args), this.vm.config.toolArgsMaxWidth);
		} catch {
			return "";
		}
	}

	private formatToolCallLine(toolCall: ToolCallInfo): string {
		const argsStr = this.summarizeToolArgs(toolCall.name, toolCall.arguments);
		const failed = toolCall.description?.startsWith("✗") || /error|failed/i.test(toolCall.result ?? "");
		const status = this.theme.fg(failed ? "error" : "success", failed ? "✗" : "✓");
		const args = argsStr ? this.theme.fg("dim", `(${argsStr})`) : "";
		return `${status} ${this.theme.fg("toolTitle", toolCall.name)}${args}`;
	}

	private labelFor(unit: TurnUnit): string {
		const info = this.vm.state.marks[unit.groupId];
		if (info?.compressedText) {
			const from = info.originalTokenEstimate ?? unit.tokenEstimate;
			const to = info.compressedTokenEstimate ?? "?";
			return `${this.theme.fg("warning", "compressed")} ${this.theme.fg("dim", `(${from} → ${to} tok)`)}`;
		}
		return `${this.kindTag(unit)}  ${unit.metadata.heading}`;
	}

	render(width: number): string[] {
		this.vm.updateLayout(this.tui.terminal.rows);
		if (this.vm.phase === "processing") return this.renderProcessing(width);
		return this.renderEditing(width);
	}

	private rule(width: number, color: Parameters<Theme["fg"]>[0] = "border"): string {
		return this.theme.fg(color, "─".repeat(Math.max(1, width)));
	}

	/** Compact, /tree-style keybinding legend: short phrases joined by " · ". */
	private helpLine(width: number): string {
		const hints = ["↑/↓ move", "space select", "c compress", "d delete", "→ preview", "enter apply", "esc cancel"];
		return truncateToWidth(this.theme.fg("muted", `  ${hints.join("  ·  ")}`), width, "…");
	}

	/** Glyph legend, so the mark language reads at a glance without memorizing keys. */
	private legendLine(): string {
		const items: [Mark, string][] = [
			["selected", "selected"],
			["unselected", "unselected"],
			["compressed", "compressed"],
			["deleted", "deleted"],
		];
		const parts = items.map(([mark, label]) => `${this.glyphFor(mark)} ${this.theme.fg("dim", label)}`);
		return `  ${parts.join("   ")}`;
	}

	/** Persistent status footer: cursor position plus a live count of pending marks. */
	private statusLine(start: number, end: number): string {
		const nDeleted = this.vm.countDeleted();
		const nCompressed = this.vm.countCompressed();
		const parts = [this.theme.fg("muted", `${start + 1}-${end} of ${this.vm.units.length}`)];
		if (nDeleted > 0) parts.push(this.theme.fg("error", `${nDeleted} to delete`));
		if (nCompressed > 0) parts.push(this.theme.fg("warning", `${nCompressed} to compress`));
		return `  ${parts.join(this.theme.fg("dim", "   ·   "))}`;
	}

	private renderEditing(width: number): string[] {
		const lines: string[] = [];
		const rule = this.rule(width);

		lines.push(rule);
		lines.push(`  ${this.theme.bold(this.theme.fg("accent", "Manage context"))}`);
		if (this.vm.phase === "confirm") {
			const nDeleted = this.vm.countDeleted();
			const nCompressed = this.vm.countCompressed();
			if (nDeleted > 0) {
				lines.push(
					this.theme.fg(
						"error",
						`  Permanently delete ${nDeleted} ${nDeleted === 1 ? "entry" : "entries"}? This cannot be undone.`,
					),
				);
			}
			if (nCompressed > 0) {
				lines.push(
					this.theme.fg(
						"warning",
						`  Compact ${nCompressed} ${nCompressed === 1 ? "entry" : "entries"} into ${nCompressed === 1 ? "a summary" : "summaries"}?`,
					),
				);
			}
			lines.push(this.theme.fg("muted", "  y/enter confirm   n back   esc/ctrl+c cancel"));
		} else {
			lines.push(this.helpLine(width));
			lines.push(this.legendLine());
		}
		lines.push(rule);

		// The view-model already computed the list budget for this terminal
		// height in updateLayout() (called at the top of render()).
		const start = this.vm.scrollTop;
		const end = Math.min(this.vm.units.length, start + this.vm.maxVisible);
		const showScrollbar = this.vm.units.length > this.vm.maxVisible;
		const thumb = showScrollbar ? this.scrollbarThumb(this.vm.maxVisible, this.vm.units.length, this.vm.scrollTop) : null;

		for (let i = start; i < end; i++) {
			const unit = this.vm.units[i];
			const isCursor = i === this.vm.cursor;
			const glyph = this.glyphFor(this.vm.effectiveMark(unit.groupId));
			const cursorMark = isCursor ? this.theme.fg("accent", "› ") : "  ";
			const label = this.labelFor(unit);
			const text = isCursor ? this.theme.bold(label) : label;
			const tokensText = `${unit.tokenEstimate}t`;
			const tokensRendered = this.theme.fg("dim", tokensText);

			const scrollCol = showScrollbar ? 2 : 0;
			const rowWidth = Math.max(this.vm.config.minRowWidth, width) - scrollCol;
			const leftBudget = Math.max(this.vm.config.minRowLeftBudget, rowWidth - visibleWidth(tokensText) - this.vm.config.rowTokenGap);
			const leftPart = truncateToWidth(`${cursorMark}${glyph} ${text}`, leftBudget, "…");
			const gap = Math.max(1, leftBudget - visibleWidth(leftPart) + 1);

			let line = `${leftPart}${" ".repeat(gap)}${tokensRendered}`;
			line = truncateToWidth(line, rowWidth, "", true);
			if (isCursor) line = this.theme.bg("selectedBg", line);

			if (showScrollbar && thumb) {
				const r = i - start;
				const onThumb = r >= thumb.start && r < thumb.start + thumb.size;
				line += ` ${this.theme.fg(onThumb ? "accent" : "dim", onThumb ? "█" : "│")}`;
			}
			lines.push(line);
		}
		lines.push(this.statusLine(start, end));

		if (this.vm.previewGroupId) {
			const unit = this.vm.units.find((u) => u.groupId === this.vm.previewGroupId);
			if (unit) {
				lines.push("");

				// The preview is rendered as its own bordered window (not just
				// text flowing at the outer TUI width) so the scrollbar has a
				// track to sit in that clearly belongs to the preview, not the
				// picker around it.
				const boxWidth = Math.max(this.vm.config.minPreviewBoxWidth, width);
				this.vm.updatePreviewLayout(this.tui.terminal.rows, lines.length, boxWidth);
				const contentWidth = this.vm.previewContentWidth;

				const fullLines = this.previewLines(unit);
				this.vm.setPreviewGeometry(fullLines.length, fullLines.reduce((max, l) => Math.max(max, visibleWidth(l)), 0));
				const viewportHeight = Math.max(1, Math.min(this.vm.previewMaxVisible, fullLines.length));
				const maxScrollTop = Math.max(0, fullLines.length - viewportHeight);
				const scrollTop = Math.min(this.vm.previewScrollTop, maxScrollTop);
				const visibleLines = fullLines.slice(scrollTop, scrollTop + viewportHeight);
				const showVScrollbar = fullLines.length > viewportHeight;
				const vThumb = this.scrollbarThumb(viewportHeight, fullLines.length, scrollTop);

				const maxLineWidth = fullLines.reduce((max, l) => Math.max(max, visibleWidth(l)), 0);
				const maxScrollLeft = Math.max(0, maxLineWidth - contentWidth);
				const scrollLeft = Math.min(this.vm.previewScrollLeft, maxScrollLeft);
				const showHScrollbar = maxLineWidth > contentWidth;
				const hThumb = this.scrollbarThumb(contentWidth, maxLineWidth, scrollLeft);

				const border = this.theme.fg("borderAccent", "│");
				const titleText = ` preview — ${oneLine(unit.metadata.heading, Math.max(this.vm.config.minPreviewTitleWidth, boxWidth - this.vm.config.previewTitleReserveCols))} `;
				const titleRule = "─".repeat(Math.max(0, boxWidth - 2 - visibleWidth(titleText)));
				lines.push(this.theme.fg("borderAccent", `┌${titleText}${titleRule}┐`));
				for (let i = 0; i < viewportHeight; i++) {
					const raw = visibleLines[i] ?? "";
					const windowed = sliceByColumn(raw, scrollLeft, contentWidth);
					const content = truncateToWidth(windowed, contentWidth, "", true);
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
				lines.push(this.theme.fg("borderAccent", `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`));

				const scrollHints: string[] = [];
				if (showVScrollbar) scrollHints.push("↑/↓ scroll  pgup/pgdn page");
				if (showHScrollbar) scrollHints.push("→ scroll  home/end jump  ← close");
				const hint = scrollHints.length > 0 ? `   ${scrollHints.join("   ")}` : "";
				lines.push(
					this.theme.fg("dim", `  line ${scrollTop + 1}-${scrollTop + viewportHeight} of ${fullLines.length}${hint}`),
				);
				lines.push(this.theme.fg("dim", "  enter/esc/space/ctrl+c/left close   m mode"));
			}
		}
		return lines;
	}

	private previewLines(unit: TurnUnit): string[] {
		const compressedText = this.vm.state.marks[unit.groupId]?.compressedText;

		if (compressedText) {
			return this.renderCompressedPreview(unit, compressedText);
		}

		if (this.vm.previewMode === "detailed") {
			return this.renderDetailedPreview(unit);
		}

		return this.renderEnhancedPreview(unit);
	}

	/** Section heading used inside the preview: bold label, no framing of its own. */
	private sectionHeading(label: string): string {
		return this.theme.bold(this.theme.fg("text", label));
	}

	/** Render enhanced preview with metadata for the original entry. */
	private renderEnhancedPreview(unit: TurnUnit): string[] {
		const lines: string[] = [];

		lines.push(`${this.kindTag(unit)}  ${this.theme.bold(unit.metadata.heading)}`);
		lines.push(
			this.theme.fg(
				"dim",
				`${unit.timestamp}  ·  ${unit.tokenEstimate} tok`,
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(this.vm.config.sectionRuleWidth)));
		lines.push("");

		if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
			lines.push(this.sectionHeading("Tool calls"));
			for (const toolCall of unit.metadata.toolCalls) {
				lines.push(`  ${this.formatToolCallLine(toolCall)}`);
			}
			lines.push("");
		}

		lines.push(this.sectionHeading("Content"));
		const contentLines = unit.metadata.summary.split("\n");
		const contentLimit = this.vm.config.compactContentLineLimit;
		contentLines.slice(0, contentLimit).forEach((line) => {
			lines.push(this.theme.fg("text", oneLine(line, this.vm.config.contentLineMaxWidth)));
		});
		if (contentLines.length > contentLimit) {
			lines.push(this.theme.fg("dim", `… ${contentLines.length - contentLimit} more lines`));
		}
		lines.push("");

		return lines;
	}

	/** Render detailed preview for the original entry (LLM-optimized format). */
	private renderDetailedPreview(unit: TurnUnit): string[] {
		const lines: string[] = [];

		lines.push(`${this.kindTag(unit)}  ${this.theme.bold(unit.metadata.heading)}  ${this.theme.fg("dim", "(detailed)")}`);
		lines.push(
			this.theme.fg(
				"dim",
				`${unit.metadata.type}  ·  ${unit.timestamp}  ·  ${unit.tokenEstimate} tok`,
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(this.vm.config.sectionRuleWidth)));
		lines.push("");

		if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
			lines.push(this.sectionHeading("Tool calls"));
			unit.metadata.toolCalls.forEach((toolCall, idx) => {
				lines.push(`  ${idx + 1}. ${this.formatToolCallLine(toolCall)}`);
				const argLines = JSON.stringify(toolCall.arguments, null, this.vm.config.toolArgsJsonIndent).split("\n");
				argLines.forEach((line) => lines.push(this.theme.fg("dim", `     ${line}`)));
				if (toolCall.result) {
					lines.push(
						this.theme.fg("dim", `     → ${oneLine(toolCall.description || toolCall.result, this.vm.config.toolResultMaxWidth)}`),
					);
				}
			});
			lines.push("");
		}

		lines.push(this.sectionHeading("Content"));
		const contentLines = unit.metadata.summary.split("\n");
		const contentLimit = this.vm.config.detailedContentLineLimit;
		contentLines.slice(0, contentLimit).forEach((line) => {
			lines.push(this.theme.fg("text", oneLine(line, this.vm.config.contentLineMaxWidth)));
		});
		if (contentLines.length > contentLimit) {
			lines.push(this.theme.fg("dim", `… ${contentLines.length - contentLimit} more lines`));
		}
		lines.push("");

		lines.push(this.theme.fg("dim", "press m to switch to compact view"));

		return lines;
	}

	/** Render preview for a compressed entry. */
	private renderCompressedPreview(unit: TurnUnit, compressedText: string): string[] {
		const lines: string[] = [];
		const info = this.vm.state.marks[unit.groupId];
		const from = info?.originalTokenEstimate ?? unit.tokenEstimate;
		const to = info?.compressedTokenEstimate ?? "?";

		lines.push(`${this.glyphFor("compressed")}  ${this.theme.bold(unit.metadata.heading)}`);
		lines.push(this.theme.fg("dim", `compressed  ·  ${from} → ${to} tok`));
		lines.push(this.theme.fg("warning", "─".repeat(this.vm.config.sectionRuleWidth)));
		lines.push("");

		const contentLines = compressedText.split("\n");
		const contentLimit = this.vm.config.detailedContentLineLimit;
		contentLines.slice(0, contentLimit).forEach((line) => {
			lines.push(this.theme.fg("text", oneLine(line, this.vm.config.contentLineMaxWidth)));
		});
		if (contentLines.length > contentLimit) {
			lines.push(this.theme.fg("dim", `… ${contentLines.length - contentLimit} more lines`));
		}
		lines.push("");

		return lines;
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
		lines.push(this.rule(width));
		lines.push(`  ${this.theme.bold(this.theme.fg("accent", "Applying changes"))}`);
		lines.push("");
		const barWidth = Math.max(
			this.vm.config.progressBarMinWidth,
			Math.min(this.vm.config.progressBarMaxWidth, width - this.vm.config.progressBarWidthReserve),
		);
		const filled =
			this.vm.progressTotal === 0 ? barWidth : Math.round((this.vm.progressDone / this.vm.progressTotal) * barWidth);
		const bar =
			this.theme.fg("accent", "█".repeat(filled)) + this.theme.fg("dim", "░".repeat(Math.max(0, barWidth - filled)));
		lines.push(`  [${bar}] ${this.theme.fg("muted", `${this.vm.progressDone}/${this.vm.progressTotal}`)}`);
		lines.push("");
		const logRows = Math.max(this.vm.config.minProcessingLogRows, this.tui.terminal.rows - this.vm.config.processingChromeRows);
		for (const entry of this.vm.log.slice(-logRows)) {
			const color = entry.kind === "ok" ? "success" : entry.kind === "error" ? "error" : "muted";
			lines.push(`  ${this.theme.fg(color, entry.text)}`);
		}
		if (this.vm.progressDone >= this.vm.progressTotal) {
			lines.push("");
			lines.push(this.theme.fg("dim", "  done — closing…"));
		} else if (this.vm.cancelled) {
			lines.push("");
			lines.push(this.theme.fg("dim", "  cancelling…"));
		} else {
			lines.push("");
			lines.push(this.theme.fg("dim", "  esc to cancel"));
		}
		return lines;
	}

	handleInput(data: string): void {
		const result = this.vm.handleInput(data);
		if (result === "close") {
			this.done();
			return;
		}
		this.tui.requestRender();
	}
}
