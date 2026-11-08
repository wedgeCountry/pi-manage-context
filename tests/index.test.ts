import { resolve } from "node:path";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { unitHasMatchingRead, unitHasMatchingToolCallId } from "../index.ts";
import type { TurnUnit } from "../src/turn-units.ts";
import { multiToolCallEntry } from "./helpers.ts";
import { singleToolCallOf } from "../src/hooks.ts";

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
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "./hello.txt" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(true);
  });

  it("matches regardless of relative-path spelling, as long as it resolves to the same file", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "hello.txt" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(true);
  });

  it("does not match when the path differs", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "./other.txt" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match units that are not assistant_tool", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "./hello.txt" } }]);
    const unit: TurnUnit = { ...assistantToolUnit(entry), kind: "user" };

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match when the read is bundled with another tool call in the same turn", () => {
    const entry = multiToolCallEntry("entry_1", [
      { toolCallId: "call_1", toolName: "read", args: { path: "./hello.txt" } },
      { toolCallId: "call_2", toolName: "bash", args: { command: "echo hi" } },
    ]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match when the unit's sole tool call is not read", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match the unit that produced the current tool_result event itself", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_current", toolName: "read", args: { path: "./hello.txt" } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), "call_current")).toBe(false);
  });

  it("does not match when the path argument is missing or not a string", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: 123 } }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingRead(unit, resolve("./hello.txt"), OTHER_CALL_ID)).toBe(false);
  });

  it("does not match when the anchor entry is not an assistant message", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "./hello.txt" } }]);
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

describe("unitHasMatchingToolCallId", () => {
  it("matches a unit whose anchor includes a tool call with the given id", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "context-unselect", args: {} }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingToolCallId(unit, "call_1")).toBe(true);
  });

  it("does not match a different tool call id in the same unit", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "context-unselect", args: {} }]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingToolCallId(unit, "call_other")).toBe(false);
  });

  it("does not match when the target call is bundled with another tool call in the same turn", () => {
    // Hiding the unit would also hide the unrelated `read` call's result
    // bundled into the same turn — same collateral-damage guard as
    // unitHasMatchingRead's "bundled with another tool call" case below.
    const entry = multiToolCallEntry("entry_1", [
      { toolCallId: "call_1", toolName: "read", args: { path: "./hello.txt" } },
      { toolCallId: "call_2", toolName: "context-unselect", args: {} },
    ]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingToolCallId(unit, "call_2")).toBe(false);
  });

  it("does not match even when every call in the bundle is itself self-unselect-eligible", () => {
    // Conservative on purpose: two context-unselect calls bundled together
    // still isn't the single-call shape this is scoped to handle.
    const entry = multiToolCallEntry("entry_1", [
      { toolCallId: "call_1", toolName: "context-unselect", args: {} },
      { toolCallId: "call_2", toolName: "context-unselect", args: {} },
    ]);
    const unit = assistantToolUnit(entry);

    expect(unitHasMatchingToolCallId(unit, "call_2")).toBe(false);
  });

  it("does not match units that are not assistant_tool", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "context-unselect", args: {} }]);
    const unit: TurnUnit = { ...assistantToolUnit(entry), kind: "user" };

    expect(unitHasMatchingToolCallId(unit, "call_1")).toBe(false);
  });

  it("does not match when the anchor entry is not an assistant message", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "context-unselect", args: {} }]);
    const userEntry = {
      type: "message",
      id: entry.id,
      parentId: null,
      timestamp: "0",
      message: { role: "user", content: "hi", timestamp: 0 },
    } as unknown as SessionMessageEntry;
    const unit: TurnUnit = { ...assistantToolUnit(entry), anchorEntry: userEntry };

    expect(unitHasMatchingToolCallId(unit, "call_1")).toBe(false);
  });
});

describe("singleToolCallOf", () => {
  it("returns the only tool call of an assistant_tool unit", () => {
    const entry = multiToolCallEntry("entry_1", [{ toolCallId: "call_1", toolName: "read", args: { path: "/x" } }]);

    expect(singleToolCallOf(assistantToolUnit(entry))?.id).toBe("call_1");
  });

  it("returns null for multi-call units and non-tool units", () => {
    const multi = multiToolCallEntry("entry_2", [
      { toolCallId: "call_1", toolName: "read", args: {} },
      { toolCallId: "call_2", toolName: "bash", args: {} },
    ]);

    expect(singleToolCallOf(assistantToolUnit(multi))).toBeNull();
    expect(singleToolCallOf({ ...assistantToolUnit(multi), kind: "user" })).toBeNull();
  });
});
