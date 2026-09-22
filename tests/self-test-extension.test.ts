import { describe, it, expect } from "vitest";
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { loadState } from "../src/state.ts";
import { buildTurnUnits } from "../src/turn-units.ts";
import { buildFilteredMessages } from "../src/context-filter.ts";

describe("extension (integration)", () => {
    it("agent calls the view_context tool successfully", async () => {
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

        const { session } = await createAgentSession({
            modelRuntime: await ModelRuntime.create(),
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(),
            settingsManager,
            noTools: "builtin", // only extension tools are available
        });

        const calls: { toolName: string; isError: boolean }[] = [];
        session.subscribe((e) => {
            if (e.type === "tool_execution_end") calls.push({ toolName: e.toolName, isError: e.isError });
        });

        const entriesBefore = session.sessionManager.buildContextEntries();
        let entriesAfter: unknown[] = [];

        try {
            await session.prompt("Use the view_context tool to show a summary of the current context.");
            entriesAfter = session.sessionManager.buildContextEntries();
        } finally {
            session.dispose();
        }

        expect(calls).toContainEqual({ toolName: "view_context", isError: false });
        expect(entriesAfter.length).toBeGreaterThan(entriesBefore.length);
    }, 60_000);
});

describe("extension (unselect integration)", () => {
    it("agent calls the manage-context tool successfully unselecting all messages", async () => {
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

        const { session } = await createAgentSession({
            modelRuntime: await ModelRuntime.create(),
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(),
            settingsManager,
            noTools: "builtin", // only extension tools are available
        });

        const calls: { toolName: string; isError: boolean }[] = [];
        session.subscribe((e) => {
            if (e.type === "tool_execution_end") calls.push({ toolName: e.toolName, isError: e.isError });
        });

        const entriesBefore = session.sessionManager.buildContextEntries();
        let entriesAfter: ReturnType<typeof session.sessionManager.buildContextEntries> = [];

        try {
            await session.prompt("Use the manage-context tool unselect all messages.");
            entriesAfter = session.sessionManager.buildContextEntries();
        } finally {
            session.dispose();
        }

        // The tool is registered under two names (see CLAUDE.md's "One
        // implementation, multiple registered names") — the model is free to
        // call either.
        expect(calls.some((c) => c.toolName === "manage-context" || c.toolName === "manage_context_select")).toBe(
            true,
        );
        for (const call of calls) expect(call.isError).toBe(false);
        expect(entriesAfter.length).toBeGreaterThan(entriesBefore.length);

        // Raw entries only ever grow (append-only log) — that alone doesn't
        // prove unselecting did anything. Check the actual effect: marks were
        // recorded, and the filtered messages sent to the model are smaller
        // than the raw entries once those marks are applied.
        const state = loadState(session as unknown as { sessionManager: typeof session.sessionManager });
        const marks = Object.values(state.marks);
        expect(marks.length).toBeGreaterThan(0);
        expect(marks.every((m) => m.mark === "unselected")).toBe(true);

        const units = buildTurnUnits(entriesAfter);
        const filtered = buildFilteredMessages(entriesAfter, units, state);
        expect(filtered.length).toBeLessThan(entriesAfter.length);
    }, 120_000);
});