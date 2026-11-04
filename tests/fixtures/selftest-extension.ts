// selftest-extension.ts
//
// Load in interactive pi:   pi -e ./selftest-extension.ts
// Chat for a few turns, then ask: "Now run the selftest on my_tool."
//
// The parent agent calls `run_selftest`, which starts a nested headless agent.
// That nested agent loads THIS file fresh (so it sees your latest edits), gets
// the conversation so far as context, and is asked to use `my_tool`.

import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const SELF = fileURLToPath(import.meta.url);

// Recursion guard. Symbol.for() makes this counter shared across every copy of
// the module that gets loaded in the same process.
const DEPTH_KEY = Symbol.for("selftest-extension.depth");
const MAX_DEPTH = 1;
const g = globalThis as Record<symbol, number>;

/** Turn the parent's session entries into a plain-text transcript. */
function transcript(entries: any[]): string {
    const lines: string[] = [];
    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        const text =
            typeof msg.content === "string"
                ? msg.content
                : msg.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n");
        if (text.trim()) lines.push(`${msg.role.toUpperCase()}: ${text.trim()}`);
    }
    return lines.join("\n\n");
}

export default function (pi: ExtensionAPI) {
    // ---------------------------------------------------------------------------
    // The tool you are actually developing. Replace with your real implementation.
    // ---------------------------------------------------------------------------
    pi.registerTool({
        name: "my_tool",
        label: "My Tool",
        description: "Echoes the input back in upper case (placeholder for the tool under development).",
        promptSnippet: "Transform text with my_tool",
        parameters: Type.Object({
            input: Type.String({ description: "Text to transform" }),
        }),
        async execute(_id, params) {
            return {
                content: [{ type: "text", text: params.input.toUpperCase() }],
                details: { length: params.input.length },
            };
        },
    });

    // ---------------------------------------------------------------------------
    // The self-test tool: runs a nested agent with only this extension loaded.
    // ---------------------------------------------------------------------------
    pi.registerTool({
        name: "run_selftest",
        label: "Run Selftest",
        description:
            "Start a nested agent that loads a fresh copy of this extension and uses its tools " +
            "for the given task. The nested agent can also receive the conversation so far.",
        promptSnippet: "Test this extension's tools in a nested agent",
        promptGuidelines: [
            "Use run_selftest only when the user explicitly asks to run the selftest or test the extension's tool.",
        ],
        parameters: Type.Object({
            task: Type.String({ description: "What the nested agent should do, e.g. 'Use my_tool on the user's last message'" }),
            includeConversation: Type.Optional(
                Type.Boolean({ description: "Pass the conversation so far to the nested agent (default true)" }),
            ),
        }),

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const depth = g[DEPTH_KEY] ?? 0;
            if (depth >= MAX_DEPTH) {
                throw new Error("run_selftest is disabled inside a nested selftest run");
            }
            g[DEPTH_KEY] = depth + 1;

            try {
                // Fresh loader: no ambient extensions, only this file.
                const settingsManager = SettingsManager.inMemory({});
                const loader = new DefaultResourceLoader({
                    cwd: ctx.cwd,
                    agentDir: getAgentDir(),
                    settingsManager,
                    noExtensions: true,
                    noSkills: true,
                    additionalExtensionPaths: [SELF],
                });
                await loader.reload();

                const { session, extensionsResult } = await createAgentSession({
                    cwd: ctx.cwd,
                    resourceLoader: loader,
                    settingsManager,
                    modelRuntime: await ModelRuntime.create(),
                    sessionManager: SessionManager.inMemory(ctx.cwd),
                    // Allowlist: run_selftest is left out, so the child cannot recurse.
                    tools: ["my_tool"],
                });

                if (extensionsResult.errors.length > 0) {
                    throw new Error(
                        "Nested load failed: " +
                        extensionsResult.errors.map((e) => `${e.path}: ${e.error}`).join("; "),
                    );
                }
                await session.bindExtensions({});

                // Stop the child when the parent run is aborted (Esc).
                const onAbort = () => void session.abort();
                signal?.addEventListener("abort", onAbort, { once: true });

                const toolLog: string[] = [];
                let output = "";
                session.subscribe((e) => {
                    if (e.type === "tool_execution_end") {
                        const line = `${e.toolName}: ${e.isError ? "error" : "ok"}`;
                        toolLog.push(line);
                        onUpdate?.({ content: [{ type: "text", text: `nested → ${line}` }], details: {} });
                    }
                    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
                        output += e.assistantMessageEvent.delta;
                    }
                });

                const history =
                    params.includeConversation === false
                        ? ""
                        : transcript(ctx.sessionManager.getBranch());

                const prompt = history
                    ? `Here is a conversation between a user and an assistant:\n\n${history}\n\n---\n\nTask: ${params.task}`
                    : params.task;

                try {
                    await session.prompt(prompt);
                } finally {
                    signal?.removeEventListener("abort", onAbort);
                    session.dispose();
                }

                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `Nested agent tool calls:\n${toolLog.join("\n") || "(none)"}\n\n` +
                                `Nested agent answer:\n${output.trim() || "(empty)"}`,
                        },
                    ],
                    details: { toolLog },
                };
            } finally {
                g[DEPTH_KEY] = depth;
            }
        },
    });
}