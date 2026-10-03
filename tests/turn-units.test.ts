import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildTurnUnits } from "../src/turn-units.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCallEntry(entryId: string, toolCallId: string, toolName: string): SessionMessageEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
    api: "test",
    provider: "test",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: 0,
  };
  return { type: "message", id: entryId, parentId: null, timestamp: "0", message };
}

function toolResultEntry(entryId: string, toolCallId: string, text = ""): SessionMessageEntry {
  return {
    type: "message",
    id: entryId,
    parentId: null,
    timestamp: "0",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "manage-context",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 0,
    },
  };
}

function customEntry(entryId: string): SessionEntry {
  return { type: "custom", id: entryId, parentId: null, timestamp: "0", customType: "manage-context", data: {} } as SessionEntry;
}

describe("buildTurnUnits", () => {
  it("groups a tool call with its result when they're strictly adjacent", () => {
    const entries = [toolCallEntry("call_entry", "call_1", "manage-context"), toolResultEntry("result_entry", "call_1")];

    const units = buildTurnUnits(entries);

    expect(units).toHaveLength(1);
    expect(units[0].entryIds).toEqual(["call_entry", "result_entry"]);
    expect(units[0].resultEntries).toHaveLength(1);
  });

  it("skips over a bookkeeping entry interleaved between a tool call and its own result", () => {
    // Mirrors what actually happens when a tool's own execute() persists
    // state (via pi.appendEntry) before returning: the resulting "custom"
    // entry lands between the assistant's toolCall entry and the toolResult
    // entry the SDK appends afterward.
    const entries = [
      toolCallEntry("call_entry", "call_1", "manage-context"),
      customEntry("state_entry"),
      toolResultEntry("result_entry", "call_1"),
    ];

    const units = buildTurnUnits(entries);

    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("assistant_tool");
    expect(units[0].entryIds).toEqual(["call_entry", "result_entry"]);
    expect(units[0].resultEntries.map((e) => e.id)).toEqual(["result_entry"]);
  });

  it("skips over several interleaved bookkeeping entries before the result arrives", () => {
    const entries = [
      toolCallEntry("call_entry", "call_1", "manage-context"),
      customEntry("state_entry_1"),
      customEntry("state_entry_2"),
      toolResultEntry("result_entry", "call_1"),
    ];

    const units = buildTurnUnits(entries);

    expect(units).toHaveLength(1);
    expect(units[0].entryIds).toEqual(["call_entry", "result_entry"]);
  });

  it("still stops collecting at a genuine new message, not just at bookkeeping entries", () => {
    const entries = [
      toolCallEntry("call_entry", "call_1", "manage-context"),
      customEntry("state_entry"),
      { type: "message", id: "user_entry", parentId: null, timestamp: "0", message: { role: "user", content: "hi", timestamp: 0 } } as SessionMessageEntry,
      toolResultEntry("result_entry", "call_1"),
    ];

    const units = buildTurnUnits(entries);

    const toolUnit = units.find((u) => u.groupId === "call_entry")!;
    expect(toolUnit.entryIds).toEqual(["call_entry"]); // result not collected — a real message intervened first
    expect(toolUnit.resultEntries).toHaveLength(0);
  });

  it("caps a very large tool result so list/textMatch output can't balloon back up to the original size", () => {
    // Unlike user/assistant/custom_message summaries (which all go through
    // preserveLineBreaks), a tool result used to be embedded verbatim — a
    // single large file read or command output could make the manage-context
    // tool's own `list` output (and every textMatch scan) as big as the
    // context it's meant to help shrink.
    const HUGE = "x".repeat(10_000);
    const entries = [toolCallEntry("call_entry", "call_1", "read"), toolResultEntry("result_entry", "call_1", HUGE)];

    const units = buildTurnUnits(entries);
    const result = units[0].metadata.toolCalls![0].result!;

    expect(result.length).toBeLessThan(HUGE.length);
    expect(result.length).toBeLessThanOrEqual(4000);
  });
});
