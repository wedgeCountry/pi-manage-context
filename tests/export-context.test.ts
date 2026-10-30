import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi, beforeEach } from "vitest";
import extension from "../index.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function createUserMessageEntry(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

/**
 * Builds the minimal ExtensionAPI/ExtensionCommandContext pair needed to drive
 * the registered command handlers: registerCommand captures the handler, the
 * context mock records notify() calls and backs sessionManager with entries.
 */
function createHarness(entries: SessionEntry[] = []) {
	const commands: Record<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }> = {};
	const notifications: { message: string; level: string }[] = [];

	const pi = {
		registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands[name] = def;
		}),
		registerTool: vi.fn(),
		on: vi.fn(),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI;

	extension(pi);

	return {
		commands,
		notifications,
		context(cwd: string, marks: Record<string, unknown> = {}): ExtensionCommandContext {
			return {
				cwd,
				ui: { notify: vi.fn((message: string, level: string) => notifications.push({ message, level })) },
				sessionManager: {
					buildContextEntries: vi.fn(() => entries),
					getEntries: vi.fn(() => [
						...(Object.keys(marks).length > 0 ? [{ type: "custom", customType: "manage-context", data: { version: 1, marks, readHookEnabled: false } }] : []),
					]),
				},
			} as unknown as ExtensionCommandContext;
		},
	};
}

describe("export_context command", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "export-context-"));
		return async () => {
			await rm(dir, { recursive: true, force: true });
		};
	});

	it("is registered by the extension", () => {
		const { commands } = createHarness();
		expect(commands["export_context"]).toBeDefined();
	});

	it("writes a markdown file with the summarized context to the current dir", async () => {
		const entries = [createUserMessageEntry("u1", "Please fix the login bug")];
		const { commands, notifications, context } = createHarness(entries);
		const ctx = context(dir);

		await commands["export_context"].handler("", ctx);

		const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
		expect(files).toHaveLength(1);

		const markdown = await readFile(join(dir, files[0]), "utf-8");
		expect(markdown).toContain("# Context Export");
		expect(markdown).toContain("Please fix the login bug");
		expect(markdown).toContain("## Summary");
		expect(notifications.at(-1)?.level).toBe("info");
	});

	it("uses the provided filename and notifies with the full path", async () => {
		const entries = [createUserMessageEntry("u1", "hello")];
		const { commands, notifications, context } = createHarness(entries);
		const ctx = context(dir);

		await commands["export_context"].handler("my-export.md", ctx);

		const markdown = await readFile(join(dir, "my-export.md"), "utf-8");
		expect(markdown).toContain("hello");
		expect(notifications.at(-1)?.message).toContain("my-export.md");
	});

	it("rejects filenames containing path separators", async () => {
		const { commands, notifications, context } = createHarness([createUserMessageEntry("u1", "hello")]);
		const ctx = context(dir);

		await commands["export_context"].handler("sub/dir.md", ctx);

		expect(notifications.at(-1)?.level).toBe("error");
		await expect(readFile(join(dir, "sub/dir.md"), "utf-8")).rejects.toThrow();
	});

	it("excludes deleted units, mirroring what the model sees", async () => {
		const entries = [createUserMessageEntry("u1", "keep me"), createUserMessageEntry("u2", "delete me")];
		const { commands, context } = createHarness(entries);
		const ctx = context(dir, { u2: { mark: "deleted" } });

		await commands["export_context"].handler("export.md", ctx);

		const markdown = await readFile(join(dir, "export.md"), "utf-8");
		expect(markdown).toContain("keep me");
		expect(markdown).not.toContain("delete me");
	});

	it("notifies when there is nothing in context", async () => {
		const { commands, notifications, context } = createHarness([]);
		const ctx = context(dir);

		await commands["export_context"].handler("empty.md", ctx);

		expect(notifications.at(-1)?.message).toContain("No messages in context yet");
		await expect(readFile(join(dir, "empty.md"), "utf-8")).rejects.toThrow();
	});
});
