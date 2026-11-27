/**
 * Interactive `/mc config` dialogue: one mode row cycling
 * off → tool → assistant → user, and one window row holding a non-negative
 * integer. Enter saves through onSave (the caller persists it), esc/ctrl+c
 * cancels through onCancel. Rendering + keypress forwarding only — the
 * decisions are simple and local, so no separate view-model is needed.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { WindowConfig, WindowMode } from "./state.ts";
import { WINDOW_MODES } from "./window-filter.ts";

const MODE_CYCLE: readonly (WindowMode | null)[] = [null, ...WINDOW_MODES];

export class WindowConfigView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly onSave: (config: WindowConfig) => void;
	private readonly onCancel: () => void;
	private cursorRow = 0; // 0 = mode, 1 = window
	private mode: WindowMode | null;
	private windowText: string;
	private error: string | null = null;

	constructor(
		tui: TUI,
		theme: Theme,
		initial: WindowConfig,
		onSave: (config: WindowConfig) => void,
		onCancel: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.onSave = onSave;
		this.onCancel = onCancel;
		this.mode = initial.mode;
		this.windowText = initial.window !== null ? String(initial.window) : "";
	}

	invalidate(): void {}

	private cycleMode(delta: number): void {
		const idx = MODE_CYCLE.indexOf(this.mode);
		this.mode = MODE_CYCLE[(idx + delta + MODE_CYCLE.length) % MODE_CYCLE.length];
		this.error = null;
	}

	private adjustWindow(delta: number): void {
		const current = /^\d+$/.test(this.windowText) ? Number.parseInt(this.windowText, 10) : 0;
		this.windowText = String(Math.max(0, current + delta));
		this.error = null;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onCancel();
			return;
		}
		if (matchesKey(data, "up")) this.cursorRow = 0;
		else if (matchesKey(data, "down")) this.cursorRow = 1;
		else if (this.cursorRow === 0) {
			if (matchesKey(data, "left")) this.cycleMode(-1);
			else if (matchesKey(data, "right") || matchesKey(data, "space")) this.cycleMode(1);
		} else {
			if (matchesKey(data, "backspace")) this.windowText = this.windowText.slice(0, -1);
			else if (matchesKey(data, "left")) this.adjustWindow(-1);
			else if (matchesKey(data, "right")) this.adjustWindow(1);
			else if (/^[0-9]$/.test(data) && this.windowText.length < 6) this.windowText += data;
		}
		if (matchesKey(data, "enter")) {
			if (this.mode === null) {
				this.onSave({ mode: null, window: null });
				return;
			}
			if (!/^\d+$/.test(this.windowText)) {
				this.error = "window must be a non-negative integer (or set mode to off)";
			} else {
				this.onSave({ mode: this.mode, window: Number.parseInt(this.windowText, 10) });
				return;
			}
		}
		this.tui.requestRender();
	}

	private row(index: number, label: string, value: string, hint: string): string {
		const cursor = index === this.cursorRow ? this.theme.fg("accent", "› ") : "  ";
		const labelText = index === this.cursorRow ? this.theme.bold(label) : label;
		return `  ${cursor}${this.theme.fg("muted", labelText.padEnd(7))} ${this.theme.fg("accent", value)}  ${this.theme.fg("dim", hint)}`;
	}

	render(width: number): string[] {
		const rule = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const lines: string[] = [];
		lines.push(rule);
		lines.push(`  ${this.theme.bold(this.theme.fg("accent", "Context window"))}`);
		lines.push(this.theme.fg("muted", "  only the latest N units per kind of the active category reach the model"));
		lines.push("");
		lines.push(this.row(0, "mode", this.mode ?? "off", "left/right change"));
		lines.push(this.row(1, "window", this.windowText || "(unset)", "digits, backspace, left/right"));
		lines.push("");
		if (this.error) lines.push(this.theme.fg("error", `  ${this.error}`));
		lines.push(this.theme.fg("muted", "  enter save   esc cancel"));
		lines.push(rule);
		return lines;
	}
}
