/**
 * Tests for the editable context-autoselect subagent instruction:
 * renderAutoSelectTask() (placeholder substitution), buildAutoSelectTask()
 * with a custom template, and loadAutoSelectTemplate() (project override,
 * bundled file, embedded fallback).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildAutoSelectTask, type AutoListingRow } from "../src/tools/context-autoselect-engine.ts";
import {
	DEFAULT_AUTOSELECT_TEMPLATE,
	NO_FOCUS_TEXT,
	PROJECT_TEMPLATE_PATH,
	renderAutoSelectTask,
	loadAutoSelectTemplate,
} from "../src/tools/autoselect-prompt.ts";

const listing: AutoListingRow[] = [
	{ groupId: "e1", heading: "answer", type: "assistant_response", tokenEstimate: 42, summary: "answer", mark: "selected" },
];

describe("renderAutoSelectTask", () => {
	it("substitutes {{listing}} with the JSON listing and {{focus}} with the focus", () => {
		const task = renderAutoSelectTask("task: {{focus}}\nunits: {{listing}}", listing, "fix the bug");
		expect(task).toContain("task: fix the bug");
		expect(task).toContain('"groupId": "e1"');
		expect(task).not.toContain("{{");
	});

	it("uses the no-focus text when focus is missing or blank", () => {
		expect(renderAutoSelectTask("{{focus}}", listing, undefined)).toBe(NO_FOCUS_TEXT);
		expect(renderAutoSelectTask("{{focus}}", listing, "   ")).toBe(NO_FOCUS_TEXT);
	});

	it("replaces repeated placeholders", () => {
		const task = renderAutoSelectTask("{{focus}} / {{focus}}", listing, "f");
		expect(task).toBe("f / f");
	});
});

describe("buildAutoSelectTask", () => {
	it("renders the default template identically to the previous inline prompt", () => {
		const task = buildAutoSelectTask(listing, "fixing the auth bug");
		expect(task).toContain("fixing the auth bug");
		expect(task).toContain('"groupId": "e1"');
		expect(task).toContain("context-unselect ONCE");
		expect(task).toMatch(/conservative/i);
		expect(task).toMatch(/latest user turn is not in this list/i);
		expect(buildAutoSelectTask([], undefined)).toMatch(/not specified/i);
	});

	it("renders a caller-supplied custom template", () => {
		const task = buildAutoSelectTask(listing, "f", "Custom instructions for {{focus}}: {{listing}}");
		expect(task).toBe('Custom instructions for f: ' + JSON.stringify(listing, null, 2));
	});
});

describe("loadAutoSelectTemplate", () => {
	it("loads the bundled prompts/context-autoselect.md when no project override exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-prompt-"));
		try {
			const template = await loadAutoSelectTemplate(dir);
			expect(template).toContain("{{focus}}");
			expect(template).toContain("{{listing}}");
			expect(template).toContain("context-unselect ONCE");
			const onDisk = await readFile(join(import.meta.dirname, "..", "prompts", "context-autoselect.md"), "utf-8");
			expect(template).toBe(onDisk);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("prefers a per-project .pi/context-autoselect.md override", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-prompt-"));
		try {
			await mkdir(join(dir, ".pi"), { recursive: true });
			await writeFile(join(dir, PROJECT_TEMPLATE_PATH), "My custom prompt {{focus}} {{listing}}", "utf-8");
			expect(await loadAutoSelectTemplate(dir)).toBe("My custom prompt {{focus}} {{listing}}");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("the embedded default matches the shipped template's intent", () => {
		expect(DEFAULT_AUTOSELECT_TEMPLATE).toContain("{{focus}}");
		expect(DEFAULT_AUTOSELECT_TEMPLATE).toContain("{{listing}}");
		expect(renderAutoSelectTask(DEFAULT_AUTOSELECT_TEMPLATE, listing, "f")).toContain('"groupId": "e1"');
	});
});
