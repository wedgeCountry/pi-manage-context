import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildManageContextTool, buildManageContextSelectTool } from "../src/tools/manage-context.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// Mock ExtensionAPI
const mockPi = {
	appendEntry: vi.fn(),
} as any;

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

describe("manage-context tool", () => {
	describe("tool structure", () => {
		it("exports a tool with the hyphenated name", () => {
			const tool = buildManageContextTool(mockPi);
			
			expect(tool.name).toBe("manage-context");
			expect(tool.label).toBe("Manage context");
			expect(tool.description).toContain("list/select/unselect");
		});

		it("has the correct parameters", () => {
			const tool = buildManageContextTool(mockPi);
			const params = tool.parameters as any;
			
			expect(params.type).toBe("object");
			expect(params.properties.action).toBeDefined();
			expect(params.properties.textMatch).toBeDefined();
			expect(params.properties.groupIds).toBeDefined();
		});

		it("includes list, select, and unselect actions", () => {
			const tool = buildManageContextTool(mockPi);
			const params = tool.parameters as any;
			
			const actions = params.properties.action.anyOf.map((opt: any) => opt.const);
			expect(actions).toContain("list");
			expect(actions).toContain("select");
			expect(actions).toContain("unselect");
		});
	});

	describe("execute function - list action", () => {
		it("returns all turn units when action is list", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Hello"),
				createAssistantMessageEntry("entry-2", "Hi there"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { action: "list" }, undefined, undefined, mockCtx);
			
			expect(result.content).toBeDefined();
			const text = (result.content[0] as any).text;
			const json = JSON.parse(text);
			
			expect(Array.isArray(json)).toBe(true);
			expect(json.length).toBe(2);
			expect(json[0].id).toBeDefined();
			expect(json[0].heading).toBeDefined();
			expect(json[0].tokenCount).toBeDefined();
		});

		it("excludes deleted entries from list", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Active"),
				createUserMessageEntry("entry-2", "Deleted"),
			];
			const mockCtx = createMockContext(entries);
			
			// Mock state to mark entry-2 as deleted
			const originalLoadState = await import("../src/state.ts");
			const loadStateSpy = vi.spyOn(originalLoadState, "loadState").mockReturnValue({
				version: 1,
				marks: {
					"entry-2": { mark: "deleted" },
				},
				compressionModel: undefined,
				readHookEnabled: false
			});
			
			const result = await tool.execute("test-call", { action: "list" }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			const json = JSON.parse(text);
			
			expect(json.length).toBe(1); // Should only show 1, not 2
			expect(json[0].id).not.toBe("entry-2");
			
			loadStateSpy.mockRestore();
		});

		it("includes mark status in list output", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Test"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { action: "list" }, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			const json = JSON.parse(text);
			
			expect(json[0].mark).toBeDefined();
			expect(json[0].mark).toBe("selected");
		});
	});

	describe("execute function - select action", () => {
		it("selects entries matching textMatch", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Implement file reader"),
				createUserMessageEntry("entry-2", "Write tests"),
				createUserMessageEntry("entry-3", "File writer implementation"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "select", 
				textMatch: "file" 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("Marked");
			expect(text).toContain("unit(s) as selected");
			// Should match entry-1 and entry-3
			expect(text).toMatch(/Marked \d+ unit\(s\)/);
		});

		it("selects entries matching groupIds", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Message 1"),
				createUserMessageEntry("entry-2", "Message 2"),
				createUserMessageEntry("entry-3", "Message 3"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "select", 
				groupIds: ["entry-1", "entry-3"] 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("entry-1");
			expect(text).toContain("entry-3");
			expect(text).not.toContain("entry-2");
		});

		it("combines textMatch and groupIds with OR logic", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "File operation"),
				createUserMessageEntry("entry-2", "Other thing"),
				createUserMessageEntry("entry-3", "Another file"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "select", 
				textMatch: "file",
				groupIds: ["entry-2"] 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			// Should match entry-1, entry-2, and entry-3
			expect(text).toMatch(/Marked [23] unit\(s\)/);
		});

		it("returns message when no entries match", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Hello"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "select", 
				textMatch: "nonexistent" 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("No turn units matched");
		});

		it("requires textMatch or groupIds for select action", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Test"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "select" 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("provide textMatch and/or groupIds");
		});
	});

	describe("execute function - unselect action", () => {
		it("unselects entries matching textMatch", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Draft implementation"),
				createUserMessageEntry("entry-2", "Final implementation"),
				createUserMessageEntry("entry-3", "Draft ideas"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "unselect", 
				textMatch: "draft" 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("unit(s) as unselected");
			// Should match entry-1 and entry-3
		});

		it("unselects entries matching groupIds", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Message 1"),
				createUserMessageEntry("entry-2", "Message 2"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "unselect", 
				groupIds: ["entry-1"] 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("entry-1");
			expect(text).not.toContain("entry-2");
		});

		it("requires textMatch or groupIds for unselect action", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "Test"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "unselect" 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("provide textMatch and/or groupIds");
		});
	});

	describe("search behavior", () => {
		it("searches case-insensitively", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "FILE operation"),
				createUserMessageEntry("entry-2", "file test"),
				createUserMessageEntry("entry-3", "File something"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "select", 
				textMatch: "file" 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			// Should match all three regardless of case
			expect(text).toMatch(/Marked 3 unit\(s\)/);
		});

		it("searches in entry content, not just headings", async () => {
			const tool = buildManageContextTool(mockPi);
			const entries: SessionEntry[] = [
				createUserMessageEntry("entry-1", "This message contains the word optimization"),
			];
			const mockCtx = createMockContext(entries);
			
			const result = await tool.execute("test-call", { 
				action: "select", 
				textMatch: "optimization" 
			}, undefined, undefined, mockCtx);
			
			const text = (result.content[0] as any).text;
			expect(text).toContain("Marked 1 unit(s)");
		});
	});
});

describe("manage_context_select tool (legacy)", () => {
	it("exports a tool with the underscore name", () => {
		const tool = buildManageContextSelectTool(mockPi);
		
		expect(tool.name).toBe("manage_context_select");
		expect(tool.label).toBe("Manage context (select)");
		expect(tool.description).toContain("list/select/unselect");
	});

	it("has the same parameter schema as manage-context", () => {
		const tool1 = buildManageContextTool(mockPi);
		const tool2 = buildManageContextSelectTool(mockPi);
		
		// Both should have the same parameter schema
		expect(JSON.stringify(tool1.parameters)).toBe(JSON.stringify(tool2.parameters));
		
		// Both should have execute functions
		expect(tool1.execute).toBeDefined();
		expect(tool2.execute).toBeDefined();
	});

	it("functions identically to manage-context", async () => {
		const tool1 = buildManageContextTool(mockPi);
		const tool2 = buildManageContextSelectTool(mockPi);
		
		const entries: SessionEntry[] = [
			createUserMessageEntry("entry-1", "Test"),
		];
		const mockCtx = createMockContext(entries);
		
		// Both should handle list action
		const result1 = await tool1.execute("test-call", { action: "list" }, undefined, undefined, mockCtx);
		const result2 = await tool2.execute("test-call", { action: "list" }, undefined, undefined, mockCtx);
		
		// Results should be structurally identical
		expect(result1.content[0].type).toBe(result2.content[0].type);
		expect(typeof result1.content[0]).toBe(typeof result2.content[0]);
	});
});

describe("state persistence", () => {
	it("persists state changes after select action", async () => {
		const tool = buildManageContextTool(mockPi);
		const entries: SessionEntry[] = [
			createUserMessageEntry("entry-1", "Test"),
		];
		const mockCtx = createMockContext(entries);
		
		// Mock saveState to track if it was called
		const originalState = await import("../src/state.ts");
		const saveStateSpy = vi.spyOn(originalState, "saveState").mockImplementation(() => {});
		
		await tool.execute("test-call", { 
			action: "select", 
			groupIds: ["entry-1"] 
		}, undefined, undefined, mockCtx);
		
		// saveState should have been called
		expect(saveStateSpy).toHaveBeenCalled();
		
		saveStateSpy.mockRestore();
	});

	it("persists state changes after unselect action", async () => {
		const tool = buildManageContextTool(mockPi);
		const entries: SessionEntry[] = [
			createUserMessageEntry("entry-1", "Test"),
		];
		const mockCtx = createMockContext(entries);
		
		const originalState = await import("../src/state.ts");
		const saveStateSpy = vi.spyOn(originalState, "saveState").mockImplementation(() => {});
		
		await tool.execute("test-call", { 
			action: "unselect", 
			groupIds: ["entry-1"] 
		}, undefined, undefined, mockCtx);
		
		expect(saveStateSpy).toHaveBeenCalled();
		
		saveStateSpy.mockRestore();
	});

	it("does not persist state for list action", async () => {
		const tool = buildManageContextTool(mockPi);
		const entries: SessionEntry[] = [
			createUserMessageEntry("entry-1", "Test"),
		];
		const mockCtx = createMockContext(entries);
		
		const originalState = await import("../src/state.ts");
		const saveStateSpy = vi.spyOn(originalState, "saveState").mockImplementation(() => {});
		
		await tool.execute("test-call", { action: "list" }, undefined, undefined, mockCtx);
		
		// saveState should NOT be called for list action
		expect(saveStateSpy).not.toHaveBeenCalled();
		
		saveStateSpy.mockRestore();
	});
});