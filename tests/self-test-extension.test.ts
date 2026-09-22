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
        let entriesAfter: unknown[] = [];

        try {
            await session.prompt("Use the manage-context tool unselect all messages.");
            entriesAfter = session.sessionManager.buildContextEntries();
        } finally {
            session.dispose();
        }

        expect(calls).toContainEqual({ toolName: "view_context", isError: false });
        expect(entriesAfter.length).toBeGreaterThan(entriesBefore.length);
    }, 60_000);
});