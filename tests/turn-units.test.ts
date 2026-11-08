import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildTurnUnits, visibleTurnUnits, toolCallResultText } from "../src/turn-units.ts";
import { emptyState } from "../src/state.ts";
import { userEntry, assistantTextEntry, toolCallEntry, toolResultEntry, customEntry } from "./helpers.ts";

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

describe("visibleTurnUnits", () => {
  it("excludes deleted units but keeps everything else", () => {
    const entries = [userEntry("e1", "keep me"), userEntry("e2", "delete me"), assistantTextEntry("e3", "hi")];
    const state = emptyState();
    state.marks = { e2: { mark: "deleted" } };

    expect(visibleTurnUnits(entries, state).map((u) => u.groupId)).toEqual(["e1", "e3"]);
  });

  it("keeps realized compressions visible (effective compressed, raw selected)", () => {
    const entries = [userEntry("e1", "compress me")];
    const state = emptyState();
    state.marks = { e1: { mark: "selected", compressedText: "summary" } };

    expect(visibleTurnUnits(entries, state).map((u) => u.groupId)).toEqual(["e1"]);
  });
});

describe("toolCallResultText", () => {
  it("returns the matching result's preview text, or a placeholder when absent", () => {
    const entries = [toolCallEntry("call_entry", "call_1", "read"), toolResultEntry("result_entry", "call_1", "file contents")];
    const [unit] = buildTurnUnits(entries);

    expect(toolCallResultText(unit, "call_1")).toBe("file contents");
    expect(toolCallResultText(unit, "missing")).toBe("(no result yet)");
  });
});
