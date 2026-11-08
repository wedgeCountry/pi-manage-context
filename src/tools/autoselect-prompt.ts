/**
 * The context-autoselect subagent's instruction lives in its own editable
 * template file rather than inline code. Resolution order in
 * loadAutoSelectTemplate():
 *   1. <cwd>/.pi/context-autoselect.md  (per-project override)
 *   2. prompts/context-autoselect.md shipped with this extension (edit it
 *      directly — it is read at runtime, no rebuild needed)
 *   3. DEFAULT_AUTOSELECT_TEMPLATE below (only if the file is unreadable)
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

const BUNDLED_TEMPLATE_PATH = fileURLToPath(new URL("../../prompts/context-autoselect.md", import.meta.url));

/** Substituted for {{focus}} when the caller gave no focus. */
export const NO_FOCUS_TEXT = "(not specified — judge relevance to the conversation as a whole)";

/** Embedded fallback, identical to prompts/context-autoselect.md. */
export const DEFAULT_AUTOSELECT_TEMPLATE = [
	"You are reviewing the turn units of a conversation to decide which are irrelevant or outdated for the current task.",
	"",
	"Current task: {{focus}}",
	"",
	"Turn units (JSON; groupId is the identifier, mark is the current state):",
	"{{listing}}",
	"",
	"Instructions:",
	"- Call context-unselect ONCE with the groupIds of the units that are irrelevant or outdated for the current task.",
	"- Be conservative: when in doubt, keep the unit selected.",
	"- The latest user turn is not in this list; do not reference it.",
	"- If nothing should be unselected, call context-unselect with an empty groupIds array.",
].join("\n");

/** Fill the template's {{listing}} and {{focus}} placeholders. */
export function renderAutoSelectTask(template: string, listing: AutoListingRow[], focus?: string): string {
	const focusText = focus && focus.trim() ? focus : NO_FOCUS_TEXT;
	return template
		.replaceAll("{{listing}}", JSON.stringify(listing, null, 2))
		.replaceAll("{{focus}}", focusText);
}

/** Resolve the subagent instruction template: project override, then the bundled file, then the embedded default. */
export async function loadAutoSelectTemplate(cwd: string): Promise<string> {
	try {
		return await readFile(resolve(cwd, PROJECT_TEMPLATE_PATH), "utf-8");
	} catch {
		// no per-project override — fall through to the bundled file
	}
	try {
		return await readFile(BUNDLED_TEMPLATE_PATH, "utf-8");
	} catch {
		return DEFAULT_AUTOSELECT_TEMPLATE;
	}
}
