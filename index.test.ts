import { resolve } from "node:path";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { unitHasMatchingRead } from "./index.ts";
import type { TurnUnit } from "./turn-units.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCallEntry(
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

function assistantToolUnit(anchorEntry: SessionMessageEntry): TurnUnit {
  return {
    groupId: anchorEntry.id,
    kind: "assistant_tool",
    entryIds: [anchorEntry.id],
    anchorEntry,
    resultEntries: [],
    timestamp: "0",
    preview: "",
    tokenEstimate: 0,
  };
}

const OTHER_CALL_ID = "call_current"; // stands in for the read call that just produced the tool_result event

describe("unitHasMatchingRead", () => {
  it("matches a unit whose sole tool call is a read on the same path", () => {
    const entry = toolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "./hello.txt" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(true);
  });

  it("matches regardless of relative-path spelling, as long as it resolves to the same file", () => {
    const entry = toolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "hello.txt" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(true);
  });

  it("does not match when the path differs", () => {
    const entry = toolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "./other.txt" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match units that are not assistant_tool", () => {
    const entry = toolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "./hello.txt" } }]);
    const unit: TurnUnit = { ...assistantToolUnit(entry), kind: "user" };

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match when the read is bundled with another tool call in the same turn", () => {
    const entry = toolCallEntry("entry_1", [
      { toolCallId: "call_1", toolName: "read", args: { path: "./hello.txt" } },
      { toolCallId: "call_2", toolName: "bash", args: { command: "echo hi" } },
    ]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match when the unit's sole tool call is not read", () => {
    const entry = toolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match the unit that produced the current tool_result event itself", () => {
    const entry = toolCallEntry("entry_1", [{ toolCallId: "call_current", toolName: "read", args: { path: "./hello.txt" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), "call_current")).toBe(false);
  });

  it("does not match when the path argument is missing or not a string", () => {
    const entry = toolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: 123 } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match when the anchor entry is not an assistant message", () => {
    const entry = toolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "./hello.txt" } }]);
    const userEntry = {
      type: "message",
      id: entry.id,
      parentId: null,
      timestamp: "0",
      message: { role: "user", content: "hi", timestamp: 0 },
    } as unknown as SessionMessageEntry;
    const unit: TurnUnit = { ...assistantToolUnit(entry), anchorEntry: userEntry };

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });
});
