import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { UserMessage, AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildManageContextSelectTool } from "../src/agent-select-tool.ts";
import type { LLMMemoryEntry } from "../src/llm-export.ts";

function userEntry(id: string, text: string): SessionMessageEntry {
  const message: UserMessage = { role: "user", content: text, timestamp: 0 };
  return { type: "message", id, parentId: null, timestamp: "0", message };
}

function assistantTextEntry(id: string, text: string): SessionMessageEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  };
  return { type: "message", id, parentId: null, timestamp: "0", message };
}

/** An assistant message that makes a single tool call — anchor of an "assistant_tool" unit. */
function toolCallEntry(id: string, toolCallId: string, toolName: string, args: Record<string, unknown>): SessionMessageEntry {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
  return { type: "message", id, parentId: null, timestamp: "0", message };
}

function toolResultEntry(id: string, toolCallId: string, toolName: string, resultText: string): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "0",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: resultText }],
      isError: false,
      timestamp: 0,
    },
  } as unknown as SessionMessageEntry;
}

/**
 * Minimal in-memory stand-in for the real pi runtime: appendEntry() pushes a
 * "custom" entry onto the same entries array getEntries()/buildContextEntries()
 * read from, so loadState()/saveState() round-trip exactly like they do for
 * the interactive picker in view.ts.
 */
function makeHarness(entries: SessionEntry[]): { pi: ExtensionAPI; ctx: ExtensionContext } {
  let nextId = 0;
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
    sessionManager: {
      getEntries: () => entries,
      buildContextEntries: () => entries,
    },
  } as unknown as ExtensionContext;

  return { pi, ctx };
}

describe("manage_context_select tool", () => {
  it("lists every turn unit with its groupId, heading, and current mark", async () => {
    const entries = [userEntry("e1", "Please refactor the auth module"), userEntry("e2", "hi there")];
    const { pi, ctx } = makeHarness(entries);
    const tool = buildManageContextSelectTool(pi);

    const result = await tool.execute("call_1", { action: "list" }, undefined, undefined, ctx);

    const rows = JSON.parse(result.content[0].text as string) as (LLMMemoryEntry & { mark: string })[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "e1", heading: "Please refactor the auth module", mark: "selected" });
    expect(rows[1]).toMatchObject({ id: "e2", heading: "hi there", mark: "selected" });
  });

  it("unselects units whose heading matches textMatch, case-insensitively", async () => {
    const entries = [
      userEntry("e1", "Please refactor the auth module"),
      userEntry("e2", "hi there"),
      assistantTextEntry("e3", "Sure, refactoring now"),
    ];
    const { pi, ctx } = makeHarness(entries);
    const tool = buildManageContextSelectTool(pi);

    const result = await tool.execute("call_1", { action: "unselect", textMatch: "REFACTOR" }, undefined, undefined, ctx);

    expect(result.details).toEqual(["e1", "e3"]);

    const listed = await tool.execute("call_2", { action: "list" }, undefined, undefined, ctx);
    const rows = JSON.parse(listed.content[0].text as string) as (LLMMemoryEntry & { mark: string })[];
    expect(rows.find((r) => r.id === "e1")?.mark).toBe("unselected");
    expect(rows.find((r) => r.id === "e2")?.mark).toBe("selected");
    expect(rows.find((r) => r.id === "e3")?.mark).toBe("unselected");
  });

  it("matches a tool-call unit by its arguments/result text, even though its heading is always just \"Tool interactions\"", async () => {
    const entries = [
      userEntry("e1", "write a poem about pythagoras"),
      toolCallEntry("e2", "call_1", "write_file", { path: "poem.txt", content: "Roses are pythagorean..." }),
      toolResultEntry("e3", "call_1", "write_file", "Wrote poem.txt"),
      userEntry("e4", "please create a proof of his theorem"),
      toolCallEntry("e5", "call_2", "write_file", { path: "proof.txt", content: "QED" }),
      toolResultEntry("e6", "call_2", "write_file", "Wrote proof.txt"),
    ];
    const { pi, ctx } = makeHarness(entries);
    const tool = buildManageContextSelectTool(pi);

    // Sanity check the bug this guards against: the tool-call unit's heading
    // really is the generic placeholder, not anything topic-specific.
    const before = await tool.execute("call_0", { action: "list" }, undefined, undefined, ctx);
    const beforeRows = JSON.parse(before.content[0].text as string) as (LLMMemoryEntry & { mark: string })[];
    expect(beforeRows.find((r) => r.id === "e2")?.heading).toBe("Tool interactions");

    const result = await tool.execute("call_1", { action: "unselect", textMatch: "poem" }, undefined, undefined, ctx);
    expect(result.details).toEqual(["e1", "e2"]);

    const listed = await tool.execute("call_2", { action: "list" }, undefined, undefined, ctx);
    const rows = JSON.parse(listed.content[0].text as string) as (LLMMemoryEntry & { mark: string })[];
    expect(rows.find((r) => r.id === "e1")?.mark).toBe("unselected"); // user turn
    expect(rows.find((r) => r.id === "e2")?.mark).toBe("unselected"); // its tool call, matched via content
    expect(rows.find((r) => r.id === "e4")?.mark).toBe("selected"); // unrelated proof turn
    expect(rows.find((r) => r.id === "e5")?.mark).toBe("selected"); // unrelated proof tool call
  });

  it("re-selects a previously unselected unit by groupId", async () => {
    const entries = [userEntry("e1", "Please refactor the auth module"), userEntry("e2", "hi there")];
    const { pi, ctx } = makeHarness(entries);
    const tool = buildManageContextSelectTool(pi);

    await tool.execute("call_1", { action: "unselect", groupIds: ["e1"] }, undefined, undefined, ctx);
    const reselect = await tool.execute("call_2", { action: "select", groupIds: ["e1"] }, undefined, undefined, ctx);
    expect(reselect.details).toEqual(["e1"]);

    const listed = await tool.execute("call_3", { action: "list" }, undefined, undefined, ctx);
    const rows = JSON.parse(listed.content[0].text as string) as (LLMMemoryEntry & { mark: string })[];
    expect(rows.find((r) => r.id === "e1")?.mark).toBe("selected");
  });

  it("matches on groupIds or textMatch combined, without double-counting a unit matched by both", async () => {
    const entries = [
      userEntry("e1", "Please refactor the auth module"),
      userEntry("e2", "hi there"),
      userEntry("e3", "unrelated message"),
    ];
    const { pi, ctx } = makeHarness(entries);
    const tool = buildManageContextSelectTool(pi);

    const result = await tool.execute(
      "call_1",
      { action: "unselect", textMatch: "refactor", groupIds: ["e2"] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details).toEqual(["e1", "e2"]);
  });

  it("reports no match instead of throwing when nothing matches", async () => {
    const entries = [userEntry("e1", "hi there")];
    const { pi, ctx } = makeHarness(entries);
    const tool = buildManageContextSelectTool(pi);

    const result = await tool.execute("call_1", { action: "unselect", textMatch: "nonexistent" }, undefined, undefined, ctx);

    expect(result.details).toEqual([]);
    expect(result.content[0].text).toMatch(/no turn units matched/i);
  });

  it("refuses to select/unselect without a filter, leaving marks untouched", async () => {
    const entries = [userEntry("e1", "hi there")];
    const { pi, ctx } = makeHarness(entries);
    const tool = buildManageContextSelectTool(pi);

    const result = await tool.execute("call_1", { action: "unselect" }, undefined, undefined, ctx);

    expect(result.content[0].text).toMatch(/provide textMatch and\/or groupIds/i);

    const listed = await tool.execute("call_2", { action: "list" }, undefined, undefined, ctx);
    const rows = JSON.parse(listed.content[0].text as string) as (LLMMemoryEntry & { mark: string })[];
    expect(rows[0]?.mark).toBe("selected");
  });
});
