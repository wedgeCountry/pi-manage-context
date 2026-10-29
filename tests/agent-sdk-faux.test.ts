// Agent-level test using the pi SDK (createAgentSession) with pi-ai's Faux
// model. The faux provider plays the "LLM": its scripted responses drive the
// real agent loop — prompt -> model turn -> tool call -> tool execution ->
// tool result -> next model turn — so the extension's tools run against a
// real AgentSession and SessionManager without network or credentials.
//
// The same session shape is used by tests/self-test-extension.test.ts, which
// swaps the faux model for a real one (run when a provider API key is set).

import { describe, expect, it } from "vitest";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

async function createFauxSession(faux: FauxProviderHandle) {
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

    // registerNativeProvider needs a stable provider id ("faux") so the model
    // resolved from the runtime matches the one the faux core streams for.
    // An explicit refresh marks the provider as configured so prompt() passes
    // its auth preflight (faux auth always resolves).
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    runtime.registerNativeProvider({ ...faux.provider, id: "faux" });
    await runtime.refresh({ allowNetwork: false });

    return createAgentSession({
        modelRuntime: runtime,
        model: faux.getModel(),
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
        settingsManager,
        noTools: "builtin", // only extension tools are available
    });
}

describe("extension (faux agent loop)", () => {
    it("agent calls the view_context tool over the full SDK loop", async () => {
        const faux = fauxProvider();
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall("view_context", { format: "summary" })], {
                stopReason: "toolUse",
            }),
            fauxAssistantMessage("Overview shown."),
        ]);

        const { session } = await createFauxSession(faux);

        const calls: { toolName: string; isError: boolean }[] = [];
        session.subscribe((e) => {
            if (e.type === "tool_execution_end") calls.push({ toolName: e.toolName, isError: e.isError });
        });

        const entriesBefore = session.sessionManager.buildContextEntries().length;
        try {
            await session.prompt("Show a summary of the current context.");
        } finally {
            session.dispose();
        }

        expect(calls).toEqual([{ toolName: "view_context", isError: false }]);
        const entriesAfter = session.sessionManager.buildContextEntries().length;
        expect(entriesAfter).toBeGreaterThan(entriesBefore);
    }, 30_000);

    it("agent calls manage-context to unselect, marks persist and filter the context", async () => {
        const faux = fauxProvider();
        faux.setResponses([
            fauxAssistantMessage(
                [fauxToolCall("manage-context", { action: "unselect", textMatch: "context" })],
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("Unselected."),
        ]);

        const { session } = await createFauxSession(faux);

        const calls: { toolName: string; isError: boolean }[] = [];
        session.subscribe((e) => {
            if (e.type === "tool_execution_end") calls.push({ toolName: e.toolName, isError: e.isError });
        });

        try {
            await session.prompt("Unselect everything about the context.");
        } finally {
            session.dispose();
        }

        expect(calls).toEqual([{ toolName: "manage-context", isError: false }]);

        // The tool's effect is observable in persisted state and in the
        // messages that would be sent to the model afterwards.
        const { loadState } = await import("../src/state.ts");
        const { buildTurnUnits } = await import("../src/turn-units.ts");
        const { buildFilteredMessages } = await import("../src/context-filter.ts");

        const entries = session.sessionManager.buildContextEntries();
        const state = loadState(session as never);
        const marks = Object.values(state.marks);
        expect(marks.length).toBeGreaterThan(0);
        expect(marks.every((m) => m.mark === "unselected")).toBe(true);

        const units = buildTurnUnits(entries);
        const filtered = buildFilteredMessages(entries, units, state);
        expect(filtered.length).toBeLessThan(entries.length);
    }, 30_000);
});
