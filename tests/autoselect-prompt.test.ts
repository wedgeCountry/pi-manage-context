/**
 * Tests for the editable context-autoselect subagent instruction:
 * renderAutoSelectTask() (placeholder substitution), buildAutoSelectTask()
 * with a caller-supplied template, and loadAutoSelectTemplate() (project
 * override, bundled file as single source of truth, loud failure when the
 * bundled file is unreadable).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildAutoSelectTask, type AutoListingRow } from "../src/tools/context-autoselect-engine.ts";
import {
	BUNDLED_TEMPLATE_PATH,
	NO_FOCUS_TEXT,
	PROJECT_TEMPLATE_PATH,
	formatAutoListingText,
	renderAutoSelectTask,
	loadAutoSelectTemplate,
} from "../src/tools/autoselect-prompt.ts";

const listing: AutoListingRow[] = [
	{ groupId: "e1", heading: "answer", type: "assistant_response", tokenEstimate: 42, summary: "answer", mark: "selected" },
];

describe("formatAutoListingText", () => {
	it("renders one text block per entry with ID first, then heading/type/tokens/mark, then the indented summary", () => {
		const text = formatAutoListingText([
			{ groupId: "e1", heading: "first answer", type: "assistant_response", tokenEstimate: 42, summary: "line one\nline two", mark: "selected" },
			{ groupId: "e2", heading: "old question", type: "user_message", tokenEstimate: 7, summary: "q", mark: "unselected" },
		]);

		expect(text).toBe(
			[
				"- ID: e1",
				"  Heading: first answer",
				"  Type: assistant_response | Tokens: ~42 | Mark: selected",
				"  Summary:",
				"  line one",
				"  line two",
				"",
				"- ID: e2",
				"  Heading: old question",
				"  Type: user_message | Tokens: ~7 | Mark: unselected",
				"  Summary:",
				"  q",
			].join("\n"),
		);
	});

	it("renders a placeholder line for an empty listing", () => {
		expect(formatAutoListingText([])).toBe("(no context entries)");
	});
});

describe("renderAutoSelectTask", () => {
	it("substitutes {{listing}} with the context text list and {{focus}} with the focus", () => {
		const task = renderAutoSelectTask("task: {{focus}}\nunits: {{listing}}", listing, "fix the bug");
		expect(task).toContain("task: fix the bug");
		expect(task).toContain("- ID: e1");
		expect(task).toContain("Type: assistant_response | Tokens: ~42 | Mark: selected");
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
	it("renders the caller-supplied template with the text list and focus filled in", () => {
		const task = buildAutoSelectTask(listing, "fixing the auth bug", "Task: {{focus}}\nUnits: {{listing}}");
		expect(task).toBe("Task: fixing the auth bug\nUnits: " + formatAutoListingText(listing));
	});
});

describe("loadAutoSelectTemplate", () => {
	it("loads the bundled prompts/context-autoselect.md when no project override exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-prompt-"));
		try {
			const template = await loadAutoSelectTemplate(dir);
			expect(template).toBe(await readFile(BUNDLED_TEMPLATE_PATH, "utf-8"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("the bundled file is the single source of truth: it carries the placeholders, the rate-context instruction, and renders", async () => {
		const template = await readFile(BUNDLED_TEMPLATE_PATH, "utf-8");
		expect(template).toContain("{{focus}}");
		expect(template).toContain("{{listing}}");
		expect(template).toMatch(/rate-context/);
		expect(template).toMatch(/between 1 and 10/);
		const task = buildAutoSelectTask(listing, "fixing the auth bug", template);
		expect(task).toContain("fixing the auth bug");
		expect(task).toContain("- ID: e1");
		expect(task).not.toContain("{{");
		expect(buildAutoSelectTask([], undefined, template)).toContain(NO_FOCUS_TEXT);
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
});
