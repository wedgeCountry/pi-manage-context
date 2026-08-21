/**
 * TUI component for the /manage_context picker: a scrollable list of turn
 * units with per-row marks, an inline content preview, and a progress view
 * while queued compressions run.
 */

import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

import { compressUnit, renderUnitForCompression, resolveCompressionModel, generateRetentionSummary } from "./compression.ts";
import { saveState } from "./state.ts";
import type { Mark, ManageContextState } from "./state.ts";
import { oneLine, contentToPreviewText, extractToolArguments, extractKeyFacts, generateHeading } from "./turn-units.ts";
import type { TurnUnit, TurnUnitMetadata } from "./turn-units.ts";

interface LogLine {
	text: string;
	kind: "ok" | "error" | "info";
}

/** One entry from `TurnUnitMetadata.toolCalls` — kept local since it's only used for display formatting. */
type ToolCallInfo = NonNullable<TurnUnitMetadata["toolCalls"]>[number];

export class ManageContextView implements Component {
	private phase: "editing" | "confirm" | "processing" | "analyzing" = "editing";
	private cursor = 0;
	private scrollTop = 0;
	private readonly maxVisible: number;
	private previewGroupId: string | null = null;
	private previewScrollTop = 0;
	private previewScrollLeft = 0;
	// Cached from the last render() call so handleInput (which gets no width)
	// can clamp/step horizontal scroll against the actual box content width.
	private previewContentWidth = 40;
	private readonly previewMaxVisible = 30;
	private readonly previewHScrollStep = 4;
	private showRetentionInfo = false; // Toggle to show retention information in preview
	private previewMode: "compact" | "detailed" = "compact"; // Toggle between compact and detailed view

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
		this.maxVisible = Math.max(5, Math.min(units.length, 100));
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
		if (name === "bash" && typeof args.command === "string") return oneLine(String(args.command), 50);
		if (name === "grep" && typeof args.pattern === "string") return `/${args.pattern}/`;
		try {
			return oneLine(JSON.stringify(args), 50);
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
		const info = this.state.marks[unit.groupId];
		if (info?.compressedText) {
			const from = info.originalTokenEstimate ?? unit.tokenEstimate;
			const to = info.compressedTokenEstimate ?? "?";
			return `${this.theme.fg("warning", "compressed")} ${this.theme.fg("dim", `(${from} → ${to} tok)`)}`;
		}
		return `${this.kindTag(unit)}  ${unit.metadata.heading}`;
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
		const nDeleted = this.countDeleted();
		const nCompressed = this.countCompressed();
		const parts = [this.theme.fg("muted", `${start + 1}-${end} of ${this.units.length}`)];
		if (nDeleted > 0) parts.push(this.theme.fg("error", `${nDeleted} to delete`));
		if (nCompressed > 0) parts.push(this.theme.fg("warning", `${nCompressed} to compress`));
		return `  ${parts.join(this.theme.fg("dim", "   ·   "))}`;
	}

	private renderEditing(width: number): string[] {
		const lines: string[] = [];
		const rule = this.rule(width);

		lines.push(rule);
		lines.push(`  ${this.theme.bold(this.theme.fg("accent", "Manage context"))}`);
		if (this.phase === "confirm") {
			const nDeleted = this.countDeleted();
			const nCompressed = this.countCompressed();
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

		const start = this.scrollTop;
		const end = Math.min(this.units.length, start + this.maxVisible);
		const showScrollbar = this.units.length > this.maxVisible;
		const thumb = showScrollbar ? this.scrollbarThumb(this.maxVisible, this.units.length, this.scrollTop) : null;

		for (let i = start; i < end; i++) {
			const unit = this.units[i];
			const isCursor = i === this.cursor;
			const glyph = this.glyphFor(this.effectiveMark(unit.groupId));
			const cursorMark = isCursor ? this.theme.fg("accent", "› ") : "  ";
			const label = this.labelFor(unit);
			const text = isCursor ? this.theme.bold(label) : label;
			const tokensText = `${unit.tokenEstimate}t`;
			const tokensRendered = this.theme.fg("dim", tokensText);

			const scrollCol = showScrollbar ? 2 : 0;
			const rowWidth = Math.max(10, width) - scrollCol;
			const leftBudget = Math.max(4, rowWidth - visibleWidth(tokensText) - 2);
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

				const border = this.theme.fg("borderAccent", "│");
				const titleText = ` preview — ${oneLine(unit.metadata.heading, Math.max(10, boxWidth - 16))} `;
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
				lines.push(this.theme.fg("dim", "  enter/esc/space/ctrl+c/left close   r retention   m mode"));
			}
		}
		return lines;
	}

	private previewLines(): string[] {
		const unit = this.units.find((u) => u.groupId === this.previewGroupId);
		if (!unit) return [];
		const compressedText = this.state.marks[unit.groupId]?.compressedText;

		if (compressedText) {
			return this.renderCompressedPreview(unit, compressedText);
		}

		if (this.previewMode === "detailed") {
			return this.renderDetailedPreview(unit);
		}

		return this.renderEnhancedPreview(unit);
	}

	/** Section heading used inside the preview: bold label, no framing of its own. */
	private sectionHeading(label: string): string {
		return this.theme.bold(this.theme.fg("text", label));
	}

	/**
	 * Render enhanced preview with metadata for the original entry.
	 */
	private renderEnhancedPreview(unit: TurnUnit): string[] {
		const lines: string[] = [];

		lines.push(`${this.kindTag(unit)}  ${this.theme.bold(unit.metadata.heading)}`);
		lines.push(
			this.theme.fg(
				"dim",
				`${unit.timestamp}  ·  ${unit.tokenEstimate} tok  ·  importance ${unit.metadata.importanceScore}/100`,
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(40)));
		lines.push("");

		// Tool calls section (if applicable)
		if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
			lines.push(this.sectionHeading("Tool calls"));
			for (const toolCall of unit.metadata.toolCalls) {
				lines.push(`  ${this.formatToolCallLine(toolCall)}`);
			}
			lines.push("");
		}

		// Content section
		lines.push(this.sectionHeading("Content"));
		const contentLines = unit.metadata.summary.split("\n");
		contentLines.slice(0, 15).forEach((line) => {
			lines.push(this.theme.fg("text", oneLine(line, 80)));
		});
		if (contentLines.length > 15) {
			lines.push(this.theme.fg("dim", `… ${contentLines.length - 15} more lines`));
		}
		lines.push("");

		// Key facts section
		if (unit.metadata.keyFacts && unit.metadata.keyFacts.length > 0) {
			lines.push(this.sectionHeading("Key facts"));
			unit.metadata.keyFacts.forEach((fact) => {
				lines.push(`  ${this.theme.fg("accent", "•")} ${fact}`);
			});
			lines.push("");
		}

		// Retention reason
		if (unit.metadata.retentionReason) {
			lines.push(this.sectionHeading("Retention reason"));
			lines.push(this.theme.fg("dim", unit.metadata.retentionReason));
			lines.push("");
		}

		// Show retention summary when toggle is enabled
		if (this.showRetentionInfo) {
			lines.push(this.theme.fg("warning", "─".repeat(40)));
			lines.push(this.theme.bold(this.theme.fg("warning", "Retention analysis")));
			const retentionSummary = generateRetentionSummary(unit);
			retentionSummary.split("\n").forEach((line) => {
				lines.push(this.theme.fg("dim", line));
			});
			lines.push("");
			lines.push(this.theme.fg("dim", "press r to hide retention analysis"));
		}

		return lines;
	}

	/**
	 * Render detailed preview for the original entry (LLM-optimized format).
	 */
	private renderDetailedPreview(unit: TurnUnit): string[] {
		const lines: string[] = [];

		lines.push(`${this.kindTag(unit)}  ${this.theme.bold(unit.metadata.heading)}  ${this.theme.fg("dim", "(detailed)")}`);
		lines.push(
			this.theme.fg(
				"dim",
				`${unit.metadata.type}  ·  ${unit.timestamp}  ·  ${unit.tokenEstimate} tok  ·  importance ${unit.metadata.importanceScore}/100`,
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(40)));
		lines.push("");

		// Tool calls (if applicable)
		if (unit.metadata.toolCalls && unit.metadata.toolCalls.length > 0) {
			lines.push(this.sectionHeading("Tool calls"));
			unit.metadata.toolCalls.forEach((toolCall, idx) => {
				lines.push(`  ${idx + 1}. ${this.formatToolCallLine(toolCall)}`);
				const argLines = JSON.stringify(toolCall.arguments, null, 2).split("\n");
				argLines.forEach((line) => lines.push(this.theme.fg("dim", `     ${line}`)));
				if (toolCall.result) {
					lines.push(this.theme.fg("dim", `     → ${oneLine(toolCall.description || toolCall.result, 100)}`));
				}
			});
			lines.push("");
		}

		// Key facts
		if (unit.metadata.keyFacts && unit.metadata.keyFacts.length > 0) {
			lines.push(this.sectionHeading("Key facts"));
			unit.metadata.keyFacts.forEach((fact) => {
				lines.push(`  ${this.theme.fg("accent", "•")} ${fact}`);
			});
			lines.push("");
		}

		// Content
		lines.push(this.sectionHeading("Content"));
		const contentLines = unit.metadata.summary.split("\n");
		contentLines.slice(0, 20).forEach((line) => {
			lines.push(this.theme.fg("text", oneLine(line, 80)));
		});
		if (contentLines.length > 20) {
			lines.push(this.theme.fg("dim", `… ${contentLines.length - 20} more lines`));
		}
		lines.push("");

		// Retention reason
		if (unit.metadata.retentionReason) {
			lines.push(this.sectionHeading("Retention reason"));
			lines.push(this.theme.fg("dim", unit.metadata.retentionReason));
			lines.push("");
		}

		// Retention summary
		if (this.showRetentionInfo) {
			lines.push(this.theme.fg("warning", "─".repeat(40)));
			lines.push(this.theme.bold(this.theme.fg("warning", "Retention analysis")));
			const retentionSummary = generateRetentionSummary(unit);
			retentionSummary.split("\n").forEach((line) => {
				lines.push(this.theme.fg("dim", line));
			});
			lines.push("");
			lines.push(this.theme.fg("dim", "press r to hide retention analysis"));
		}

		lines.push(this.theme.fg("dim", "press m to switch to compact view"));

		return lines;
	}

	/**
	 * Render preview for a compressed entry.
	 */
	private renderCompressedPreview(unit: TurnUnit, compressedText: string): string[] {
		const lines: string[] = [];
		const info = this.state.marks[unit.groupId];
		const from = info?.originalTokenEstimate ?? unit.tokenEstimate;
		const to = info?.compressedTokenEstimate ?? "?";

		lines.push(`${this.glyphFor("compressed")}  ${this.theme.bold(unit.metadata.heading)}`);
		lines.push(this.theme.fg("dim", `compressed  ·  ${from} → ${to} tok`));
		lines.push(this.theme.fg("warning", "─".repeat(40)));
		lines.push("");

		// Show compressed content
		const contentLines = compressedText.split("\n");
		contentLines.slice(0, 20).forEach((line) => {
			lines.push(this.theme.fg("text", oneLine(line, 80)));
		});
		if (contentLines.length > 20) {
			lines.push(this.theme.fg("dim", `… ${contentLines.length - 20} more lines`));
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
		const barWidth = Math.max(10, Math.min(40, width - 10));
		const filled =
			this.progressTotal === 0 ? barWidth : Math.round((this.progressDone / this.progressTotal) * barWidth);
		const bar =
			this.theme.fg("accent", "█".repeat(filled)) + this.theme.fg("dim", "░".repeat(Math.max(0, barWidth - filled)));
		lines.push(`  [${bar}] ${this.theme.fg("muted", `${this.progressDone}/${this.progressTotal}`)}`);
		lines.push("");
		for (const entry of this.log.slice(-15)) {
			const color = entry.kind === "ok" ? "success" : entry.kind === "error" ? "error" : "muted";
			lines.push(`  ${this.theme.fg(color, entry.text)}`);
		}
		if (this.progressDone >= this.progressTotal) {
			lines.push("");
			lines.push(this.theme.fg("dim", "  done — closing…"));
		} else if (this.cancelled) {
			lines.push("");
			lines.push(this.theme.fg("dim", "  cancelling…"));
		} else {
			lines.push("");
			lines.push(this.theme.fg("dim", "  esc to cancel"));
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

		if (this.previewGroupId) {
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "escape") ||
				matchesKey(data, "space") ||
				matchesKey(data, "ctrl+c")
			) {
				this.previewGroupId = null;
			} else if (matchesKey(data, "r")) {
				// Toggle retention info display
				this.showRetentionInfo = !this.showRetentionInfo;
			} else if (matchesKey(data, "m")) {
				// Toggle preview mode (compact/detailed)
				this.previewMode = this.previewMode === "compact" ? "detailed" : "compact";
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
				else if (matchesKey(data, "left")) {
					// Close preview on left arrow
					this.previewGroupId = null;
				} else if (matchesKey(data, "right"))
					this.previewScrollLeft = Math.min(maxScrollLeft, this.previewScrollLeft + this.previewHScrollStep);
				else if (matchesKey(data, "home")) this.previewScrollLeft = 0;
				else if (matchesKey(data, "end")) this.previewScrollLeft = maxScrollLeft;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.done();
			return;
		}
		if (this.phase === "confirm") {
			if (matchesKey(data, "y") || matchesKey(data, "enter")) {
				this.startProcessing();
			} else if (matchesKey(data, "n")) {
				this.phase = "editing";
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "enter")) {
			if (this.countDeleted() > 0 || this.countCompressed() > 0) {
				this.phase = "confirm";
				this.tui.requestRender();
			} else {
				this.startProcessing();
			}
			return;
		}
		if (matchesKey(data, "up")) this.moveCursor(-1);
		else if (matchesKey(data, "down")) this.moveCursor(1);
		else if (matchesKey(data, "pageUp")) this.moveCursor(-this.maxVisible);
		else if (matchesKey(data, "pageDown")) this.moveCursor(this.maxVisible);
		else if (matchesKey(data, "space")) this.setMark(this.currentUnit().groupId, "unselected");
		else if (matchesKey(data, "c")) this.setMark(this.currentUnit().groupId, "compressed");
		else if (matchesKey(data, "d")) this.setMark(this.currentUnit().groupId, "deleted");
		else if (matchesKey(data, "right")) {
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

	/**
	 * Export current context as markdown.
	 */
	private exportToMarkdown(): void {
		// This would be called from a separate export command
		// For now, we'll just note that this method exists
		// to be used by the main extension entry point
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
