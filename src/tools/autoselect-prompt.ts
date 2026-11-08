/**
 * The context-autoselect subagent's instruction lives in its own editable
 * template file — the single source of truth for the prompt. Resolution
 * order in loadAutoSelectTemplate():
 *   1. <cwd>/.pi/context-autoselect.md  (per-project override)
 *   2. prompts/context-autoselect.md shipped with this extension (edit it
 *      directly — it is read at runtime, no rebuild needed)
 * There is deliberately NO embedded copy of the prompt in code; if the
 * bundled file is missing/unreadable, loading fails loudly instead of
 * silently running a stale prompt.
 *
 * The template may contain {{focus}} and {{listing}} placeholders, which
 * renderAutoSelectTask() fills in. buildAutoSelectTask() in
 * context-autoselect-engine.ts is the pure entry point used by tests.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AutoListingRow } from "./context-autoselect-engine.ts";

/** Per-project override, resolved against the session's cwd. */
export const PROJECT_TEMPLATE_PATH = ".pi/context-autoselect.md";

/** The bundled template — the single source of truth for the subagent prompt. */
export const BUNDLED_TEMPLATE_PATH = fileURLToPath(new URL("../../prompts/context-autoselect.md", import.meta.url));

/** Substituted for {{focus}} when the caller gave no focus. */
export const NO_FOCUS_TEXT = "(not specified — judge relevance to the conversation as a whole)";

/** Fill the template's {{listing}} and {{focus}} placeholders. */
export function renderAutoSelectTask(template: string, listing: AutoListingRow[], focus?: string): string {
	const focusText = focus && focus.trim() ? focus : NO_FOCUS_TEXT;
	return template
		.replaceAll("{{listing}}", JSON.stringify(listing, null, 2))
		.replaceAll("{{focus}}", focusText);
}

/**
 * Resolve the subagent instruction template: per-project override if present,
 * otherwise the bundled prompts/context-autoselect.md. Throws when neither is
 * readable — the prompt file is the single source of truth, so there is no
 * in-code fallback to drift out of sync.
 */
export async function loadAutoSelectTemplate(cwd: string): Promise<string> {
	try {
		return await readFile(resolve(cwd, PROJECT_TEMPLATE_PATH), "utf-8");
	} catch {
		// no per-project override — use the bundled file
	}
	try {
		return await readFile(BUNDLED_TEMPLATE_PATH, "utf-8");
	} catch (error) {
		throw new Error(`context-autoselect prompt template not found: ${BUNDLED_TEMPLATE_PATH} is unreadable (${error instanceof Error ? error.message : String(error)})`);
	}
}
