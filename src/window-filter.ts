/**
 * Context-window limiting — the single source of truth for the "only the
 * latest N units of a category stay visible" feature, shared by the
 * "context" hook (src/hooks.ts via src/context-filter.ts) and the picker's
 * grey-out rendering (src/picker/), so both surfaces always agree.
 *
 * One mode switch, not three: WindowConfig.mode is "tool" | "assistant" |
 * "user" | null, so it is always unambiguous which category is limited.
 * The window counts per message kind inside that category (assistant mode
 * keeps the latest N assistant messages AND the latest N tool-call units).
 *
 * Configuration sources, in precedence order:
 *   1. state.windowConfig — set via /mc config, persisted in the session
 *      state; when present it fully replaces the settings.json default
 *      (so "off" can override a settings.json value).
 *   2. <agentDir>/settings.json under the "manage-context" key, e.g.
 *      { "manage-context": { "mode": "assistant", "window": 10 } }.
 *      Missing file / invalid JSON / missing key / wrong types → off.
 *
 * The exclusion itself is ephemeral: computeWindowExcluded() derives the
 * out-of-window groupIds on every "context" event and they are never
 * written into state.marks. Manual marks always win — only unmarked units
 * are window-excluded (enforced at the consumption sites).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ManageContextState, WindowConfig, WindowMode } from "./state.ts";
import type { TurnUnitGroup, TurnUnitKind } from "./turn-units.ts";

export const WINDOW_MODES: readonly WindowMode[] = ["tool", "assistant", "user"];

/** Key inside the agent dir's settings.json that holds the default WindowConfig. */
export const SETTINGS_KEY = "manage-context";

/** Which turn-unit kinds each mode's window counts and limits. */
const CATEGORY_KINDS: Record<WindowMode, readonly TurnUnitKind[]> = {
	tool: ["assistant_tool"],
	assistant: ["assistant_text", "assistant_tool"],
	user: ["user", "assistant_text", "assistant_tool"],
};

export const NO_WINDOW: WindowConfig = { mode: null, window: null };

/** Coerce arbitrary JSON into a valid WindowConfig; anything invalid becomes off. */
export function normalizeWindowConfig(raw: unknown): WindowConfig {
	if (!raw || typeof raw !== "object") return { ...NO_WINDOW };
	const data = raw as Record<string, unknown>;
	const mode = WINDOW_MODES.includes(data.mode as WindowMode) ? (data.mode as WindowMode) : null;
	const window =
		typeof data.window === "number" && Number.isInteger(data.window) && data.window >= 0 ? data.window : null;
	return { mode, window };
}

/** Window filtering is active only with a valid mode AND a non-negative integer window. */
export function isWindowActive(config: WindowConfig): boolean {
	return (
		config.mode !== null &&
		config.window !== null &&
		Number.isInteger(config.window) &&
		config.window >= 0
	);
}

/**
 * Resolve the effective window config: a persisted /mc config block wins
 * over the settings.json default; absent block means inherit settings.
 */
export function resolveWindowConfig(state: ManageContextState, settingsConfig?: WindowConfig): WindowConfig {
	if (state.windowConfig !== undefined) return normalizeWindowConfig(state.windowConfig);
	return normalizeWindowConfig(settingsConfig);
}

/** Read the window default from <agentDir>/settings.json; any problem → off. */
export function readSettingsWindowConfig(agentDir: string): WindowConfig {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		if (!raw || typeof raw !== "object") return { ...NO_WINDOW };
		return normalizeWindowConfig((raw as Record<string, unknown>)[SETTINGS_KEY]);
	} catch {
		return { ...NO_WINDOW };
	}
}

let cachedSettingsConfig: WindowConfig | null = null;

/** Cached per-session read of the agent dir's settings.json (the hook runs on every LLM call). */
export function loadSettingsWindowConfig(): WindowConfig {
	if (!cachedSettingsConfig) cachedSettingsConfig = readSettingsWindowConfig(getAgentDir());
	return cachedSettingsConfig;
}

/** Test hook: drop the cached settings.json read. */
export function resetSettingsWindowConfigCache(): void {
	cachedSettingsConfig = null;
}

/**
 * groupIds that fall outside the active window. Counts per kind over ALL
 * units of the category's kinds in session order (marks ignored for
 * counting — "the last N tool calls" means all tool calls), keeping the
 * latest `window` of each kind. Returns an empty set when inactive.
 */
export function computeWindowExcluded(groups: readonly TurnUnitGroup[], config: WindowConfig): Set<string> {
	const excluded = new Set<string>();
	if (!isWindowActive(config)) return excluded;
	const kinds = new Set<TurnUnitKind>(CATEGORY_KINDS[config.mode as WindowMode]);
	const window = config.window as number;
	const counts = new Map<TurnUnitKind, number>();
	for (let i = groups.length - 1; i >= 0; i--) {
		const group = groups[i];
		if (!kinds.has(group.kind)) continue;
		const seen = (counts.get(group.kind) ?? 0) + 1;
		counts.set(group.kind, seen);
		if (seen > window) excluded.add(group.groupId);
	}
	return excluded;
}

export type WindowConfigArgs =
	| { ok: true; config: WindowConfig }
	| { ok: false; error: string };

/**
 * Parse the non-interactive `/mc config` arguments:
 *   "off"                  → filtering off
 *   "<tool|assistant|user> <N>" → that mode, window N (non-negative integer)
 */
export function parseWindowConfigArgs(args: string): WindowConfigArgs {
	const trimmed = args.trim();
	if (trimmed === "off") return { ok: true, config: { ...NO_WINDOW } };
	const parts = trimmed.split(/\s+/);
	if (parts.length !== 2) {
		return { ok: false, error: `expected "off" or "<tool|assistant|user> <N>", got "${trimmed}"` };
	}
	const [modeArg, windowArg] = parts;
	if (!WINDOW_MODES.includes(modeArg as WindowMode)) {
		return { ok: false, error: `unknown mode "${modeArg}" (expected tool, assistant or user)` };
	}
	if (!/^\d+$/.test(windowArg)) {
		return { ok: false, error: `window must be a non-negative integer, got "${windowArg}"` };
	}
	return { ok: true, config: { mode: modeArg as WindowMode, window: Number.parseInt(windowArg, 10) } };
}
