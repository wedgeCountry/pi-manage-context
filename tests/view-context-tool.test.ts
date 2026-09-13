import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildViewContextTool } from "../src/view-context-tool.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// Mock helpers
function createMockContext(entries: SessionEntry[] = []): ExtensionContext {
	return {
		sessionManager: {
			buildContextEntries: vi.fn(() => entries),
			getEntries: vi.fn(() => entries),
		},
	} as unknown as ExtensionContext;
}

function createUserMessageEntry(id: string, content: string, timestamp?: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: timestamp || new Date().toISOString(),
		message: {
			role: "user",
			content,
			timestamp: Date.now(),
		},
	};
}

function createAssistantMessageEntry(id: string, content: string, timestamp?: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: timestamp || new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: content }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

describe("view_context tool", () => {
	describe("tool structure", () => {
		it("exports a tool with the correct name and description", () => {
			const tool = buildViewContextTool();
			
			expect(tool.name).toBe("view_context");
			expect(tool.label).toBe("View context overview");
			expect(tool.description).toContain("readable overview");
			expect(tool.description).toContain("/manage_context");
		});

		it("has the correct parameters", () => {
			const tool = buildViewContextTool();
			const params = tool.parameters as any;
			
			expect(params.type).toBe("object");
			expect(params.properties.format).toBeDefined();
			expect(params.properties.includeDeleted).toBeDefined();
			expect(params.properties.showRetention).toBeDefined();
			
			expect(params.properties.format.enum).toEqual(["summary", "detailed", "llm-json"]);
		});
	});

	describe("execute function", () => {
		it("returns empty message when no entries exist", async () => {
			const tool = buildViewContextTool();
			const mockCtx = createMockContext([]);
			
			const result = await tool.execute("test-call", {}, undefined, undefined, mockCtx);
			
			expect(result.content).toBeDefined();
			expect(result.content[0].type).toBe("text");
			expect((result.content[0] as any).text).toContain("No entries in context");
		});

		it("handles summary format correctly", async () => {
			const tool = buildViewContextTool();
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Hello"),
				createAssistantMessageEntry("entry-2", "Hi there"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { format: "summary" }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("CONTEXT OVERVIEW");
			expect(text).toContain("Total entries: 2");
			expect(text).toContain("User messages: 1");
			expect(text).toContain("Assistant responses: 1");
		});

		it("handles detailed format correctly", async () => {
			const tool = buildViewContextTool();
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Implement feature X"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { format: "detailed" }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("DETAILED CONTEXT OVERVIEW");
			expect(text).toContain("ENTRY 1");
			expect(text).toContain("Implement feature X");
		});

		it("handles llm-json format correctly", async () => {
			const tool = buildViewContextTool();
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Test message"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { format: "llm-json" }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			const json = JSON.parse(text);
			
			expect(json.summary).toBeDefined();
			expect(json.summary.totalEntries).toBe(1);
			expect(json.entries).toBeDefined();
			expect(Array.isArray(json.entries)).toBe(true);
			expect(json.entries[0].heading).toBeDefined();
		});

		it("excludes deleted entries by default", async () => {
			const tool = buildViewContextTool();
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Active message"),
				createUserMessageEntry("entry-2", "Deleted message"),
			];
			const mockCtx = createMockContext(entries);
			
			// Mock state to mark entry-2 as deleted
			const originalLoadState = await import("../src/state.ts");
			const loadStateSpy = vi.spyOn(originalLoadState, "loadState").mockReturnValue({
				marks: {
					"entry-2": { mark: "deleted" },
				},
				compressionModel: undefined,
				readHookEnabled: false,
			});
			
			const result = await tool.execute("test-call", {}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("Total entries: 1"); // Should only show 1, not 2
			
			loadStateSpy.mockRestore();
		});

		it("includes deleted entries when includeDeleted=true", async () => {
			const tool = buildViewContextTool();
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Active message"),
				createUserMessageEntry("entry-2", "Deleted message"),
			];
			const mockCtx = createMockContext(entries);
			
			// Mock state to mark entry-2 as deleted
			const originalLoadState = await import("../src/state.ts");
			const loadStateSpy = vi.spyOn(originalLoadState, "loadState").mockReturnValue({
				marks: {
					"entry-2": { mark: "deleted" },
				},
				compressionModel: undefined,
				readHookEnabled: false,
			});
			
			const result = await tool.execute("test-call", { includeDeleted: true }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("Total entries: 2"); // Should show both
			
			loadStateSpy.mockRestore();
		});

		it("includes retention analysis when showRetention=true in detailed format", async () => {
			const tool = buildViewContextTool();
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Important requirement"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { format: "detailed", showRetention: true }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("Retention");
		});
	});

	describe("formatSummary function", () => {
		it("shows correct entry counts by type", async () => {
			const tool = buildViewContextTool();
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "User 1"),
				createUserMessageEntry("entry-2", "User 2"),
				createAssistantMessageEntry("entry-3", "Assistant 1"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { format: "summary" }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("User messages: 2");
			expect(text).toContain("Assistant responses: 1");
		});

		it("shows token counts", async () => {
			const tool = buildViewContextTool();
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Test"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { format: "summary" }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("Total tokens:");
		});

		it("shows selection status", async () => {
			const tool = buildViewContextTool();
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Test"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { format: "summary" }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("selected");
		});
	});
});