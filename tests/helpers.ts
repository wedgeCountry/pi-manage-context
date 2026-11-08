/**
 * Shared fixtures for the unit/integration tests: minimal in-memory session
 * entry factories plus a fake pi runtime whose appendEntry() pushes "custom"
 * entries onto the same array getEntries()/buildContextEntries() read from,
 * so loadState()/saveState() round-trip exactly like they do in a real session.
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";

export const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function userEntry(id: string, text: string): SessionMessageEntry {
	const message: UserMessage = { role: "user", content: text, timestamp: 0 };
	return { type: "message", id, parentId: null, timestamp: "0", message };
}

export function assistantTextEntry(id: string, text: string): SessionMessageEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
	return { type: "message", id, parentId: null, timestamp: "0", message };
}

export function toolCallEntry(entryId: string, toolCallId: string, toolName: string, args: Record<string, unknown> = {}): SessionMessageEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
	return { type: "message", id: entryId, parentId: null, timestamp: "0", message };
}

export function multiToolCallEntry(
	entryId: string,
	calls: { toolCallId: string; toolName: string; args: Record<string, unknown> }[],
): SessionMessageEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.toolCallId, name: c.toolName, arguments: c.args })),
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
	return { type: "message", id: entryId, parentId: null, timestamp: "0", message };
}

export function toolResultEntry(entryId: string, toolCallId: string, text = "", toolName = "context-unselect"): SessionMessageEntry {
	return {
		type: "message",
		id: entryId,
		parentId: null,
		timestamp: "0",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
		},
	};
}

export function customEntry(entryId: string, customType = "manage-context", data: unknown = {}): SessionEntry {
	return { type: "custom", id: entryId, parentId: null, timestamp: "0", customType, data } as SessionEntry;
}

/** Minimal in-memory stand-in for the real pi runtime (see module doc). */
export function makeHarness(entries: SessionEntry[]): { pi: ExtensionAPI; ctx: ExtensionContext; notifies: string[] } {
	let nextId = 0;
	const notifies: string[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				id: `custom_${nextId++}`,
				parentId: null,
				timestamp: "0",
				customType,
				data,
			} as SessionEntry);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: process.cwd(),
		model: undefined,
		sessionManager: {
			getEntries: () => entries,
			buildContextEntries: () => entries,
		},
		ui: { notify: (msg: string) => notifies.push(msg) },
	} as unknown as ExtensionContext;

	return { pi, ctx, notifies };
}
