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

        // The manage-context tool call itself — the assistant's toolCall
        // block plus the toolResult it produced — should never be sent back
        // to the model: unselecting is meant to shrink context, not spend
        // tokens reporting on itself every subsequent turn. It should be
        // auto-unselected without the model (or this test) having to ask for
        // it explicitly. But only the *last* such call auto-hides — if the
        // model called the tool more than once, earlier calls stay visible
        // rather than all of them silently vanishing.
        const SELF_TOOL_NAMES = new Set(["manage-context", "manage_context_select"]);
        const selfToolCallIds = (u: (typeof units)[number]): string[] => {
            if (u.anchorEntry.type !== "message" || u.anchorEntry.message.role !== "assistant") return [];
            return u.anchorEntry.message.content
                .filter((c: any) => c.type === "toolCall" && SELF_TOOL_NAMES.has(c.name))
                .map((c: any) => c.id as string);
        };
        const idPresentInFiltered = (ids: Set<string>) =>
            filtered.some((m) => {
                if (m.role === "assistant" && Array.isArray(m.content)) {
                    return m.content.some((c: any) => c.type === "toolCall" && ids.has(c.id));
                }
                if (m.role === "toolResult") return ids.has(m.toolCallId);
                return false;
            });

        const selfUnits = units.filter((u) => u.kind === "assistant_tool" && selfToolCallIds(u).length > 0);
        expect(selfUnits.length).toBeGreaterThan(0);

        const lastSelfUnit = selfUnits[selfUnits.length - 1];
        expect(idPresentInFiltered(new Set(selfToolCallIds(lastSelfUnit)))).toBe(false);

        if (selfUnits.length > 1) {
            const earlierIds = new Set(selfUnits.slice(0, -1).flatMap(selfToolCallIds));
            expect(idPresentInFiltered(earlierIds)).toBe(true);
        }

        // The assistant's final report to the user (a separate turn unit,
        // kind "assistant_text") must stay — only the manage-context tool's
        // own call/result unit auto-unselects, never the assistant's
        // subsequent reply. Checked against the unit's mark directly rather
        // than assuming its content always includes a text block: some
        // models end a turn with an empty-content assistant message, and
        // that's a model-behavior detail this test shouldn't be sensitive to.
        const finalTextUnit = units.find((u) => u.kind === "assistant_text");
        expect(finalTextUnit).toBeDefined();
        expect(state.marks[finalTextUnit!.groupId]?.mark).not.toBe("unselected");
    }, 120_000);
});