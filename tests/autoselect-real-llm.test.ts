// End-to-end test against a REAL LLM, runnable from bash:
//
//   npm test -- autoselect-real-llm          # or: npx vitest run tests/autoselect-real-llm.test.ts
//
// It starts one session (pi SDK, global pi setup: ~/.pi/agent/settings.json for
// the default model, auth.json/env API keys for credentials), gives the model
// a task to read a file twice, then tells the agent in the SAME session to
// auto-clean its context via context-autoselect. Expected outcome:
//
//   1. The first read call is unselected (the autoselect subagent judges the
//      duplicate read of the same file as outdated).
//   2. The context-autoselect tool call itself is auto-unselected by the
//      self-unselect hook, so it is NOT part of the LLM's context afterwards.
//
// Skips automatically when no provider credential is available, so plain
// `npm test` stays green offline.

import { describe, it, expect } from "vitest";
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    readStoredCredential,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";

const hasProviderCredential = () => {
    const envKeys = [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "MISTRAL_API_KEY",
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY",
        "XAI_API_KEY",
        "GROQ_API_KEY",
    ];
    if (envKeys.some((name) => Boolean(process.env[name]))) return true;
    const stored = ["anthropic", "openai", "mistral", "google", "openrouter", "deepseek", "xai", "groq"];
    return stored.some((provider) => readStoredCredential(provider) !== undefined);
};

const maybeIt = hasProviderCredential() ? it : it.skip;

import extension from "../index.ts";
import { loadState } from "../src/state.ts";
import { buildTurnUnits } from "../src/turn-units.ts";
import { buildFilteredMessages } from "../src/context-filter.ts";

async function createGlobalSession() {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        extensionFactories: [extension],
    });
    await loader.reload();

    return createAgentSession({
        modelRuntime: await ModelRuntime.create(),
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
        settingsManager,
        noTools: "builtin", // only extension tools are available
    });
}

/** Tool call ids of the given tool name inside one turn unit. */
function toolCallIdsOf(unit: ReturnType<typeof buildTurnUnits>[number], toolName: string): string[] {
    if (unit.anchorEntry.type !== "message" || unit.anchorEntry.message.role !== "assistant") return [];
    return unit.anchorEntry.message.content
        .filter((c: any) => c.type === "toolCall" && c.name === toolName)
        .map((c: any) => c.id as string);
}

/** True if any filtered message still carries one of the given tool call ids. */
function idPresentInFiltered(filtered: unknown[], ids: Set<string>): boolean {
    return (filtered as any[]).some((m) => {
        if (m.role === "assistant" && Array.isArray(m.content)) {
            return m.content.some((c: any) => c.type === "toolCall" && ids.has(c.id));
        }
        if (m.role === "toolResult") return ids.has(m.toolCallId);
        return false;
    });
}

describe("context-autoselect (real LLM, end to end)", () => {
    maybeIt("auto-clean unselects the first read and hides its own tool call from context", async () => {
        const { session } = await createGlobalSession();

        const calls: { toolName: string; isError: boolean }[] = [];
        session.subscribe((e) => {
            if (e.type === "tool_execution_end") calls.push({ toolName: e.toolName, isError: e.isError });
        });

        try {
            // Turn 1: the model reads the same file twice.
            await session.prompt(
                "Use the read tool to read the file README.md in this project, and then read the same file again in a separate step.",
            );
            // Turn 2 (same session): ask the agent to auto-clean its context.
            await session.prompt(
                "Now auto clean your context: use context-autoselect with a focus on what we are doing, so irrelevant or outdated units get unselected.",
            );
        } finally {
            session.dispose();
        }

        for (const call of calls) expect(call.isError).toBe(false);
        expect(calls.filter((c) => c.toolName === "read").length).toBeGreaterThanOrEqual(2);
        expect(calls.some((c) => c.toolName === "context-autoselect")).toBe(true);

        const entries = session.sessionManager.buildContextEntries();
        const state = loadState(session as unknown as { sessionManager: typeof session.sessionManager });
        const units = buildTurnUnits(entries);
        const filtered = buildFilteredMessages(entries, units, state);

        // Expectation 1: the first read call was unselected by the autoselect
        // subagent (a duplicate read of the same file is outdated).
        const readUnits = units.filter((u) => u.kind === "assistant_tool" && toolCallIdsOf(u, "read").length > 0);
        expect(readUnits.length).toBeGreaterThanOrEqual(1);
        expect(state.marks[readUnits[0].groupId]?.mark).toBe("unselected");

        // Expectation 2: the context-autoselect tool call itself is
        // auto-unselected (self-unselect hook) and absent from the messages
        // the LLM would see next — only the LAST such call auto-hides.
        const autoUnits = units.filter(
            (u) => u.kind === "assistant_tool" && toolCallIdsOf(u, "context-autoselect").length > 0,
        );
        expect(autoUnits.length).toBeGreaterThan(0);
        const lastAutoUnit = autoUnits[autoUnits.length - 1];
        expect(state.marks[lastAutoUnit.groupId]?.mark).toBe("unselected");
        expect(idPresentInFiltered(filtered, new Set(toolCallIdsOf(lastAutoUnit, "context-autoselect")))).toBe(false);

        // The unselects actually shrunk what the model sees.
        expect(filtered.length).toBeLessThan(entries.length);
    }, 300_000);
});
