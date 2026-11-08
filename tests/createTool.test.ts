/**
 * Tests for the shared createTool() factory (the pi-small-models tool
 * pattern): it spreads the static definition and adapts pi's 5-argument
 * execute(toolCallId, params, signal, onUpdate, ctx) into the hooks'
 * execute(params, { signal, ctx }).
 */
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTool } from "../src/tools/createTool.ts";

describe("createTool", () => {
	it("keeps the static definition fields and adapts the execute signature", async () => {
		const definition = {
			name: "demo",
			label: "Demo",
			description: "demo tool",
			parameters: Type.Object({ x: Type.String() }),
		};
		const execute = vi.fn(async (params: { x: string }, _env: { signal: AbortSignal | undefined; ctx: ExtensionContext }) => ({
			content: [{ type: "text" as const, text: `got ${params.x}` }],
			details: params.x.length,
		}));

		const tool = createTool(definition, { execute });

		expect(tool.name).toBe("demo");
		expect(tool.label).toBe("Demo");
		expect(tool.parameters).toBe(definition.parameters);

		const ctx = { cwd: "/tmp" } as unknown as ExtensionContext;
		const signal = new AbortController().signal;
		const result = await tool.execute("call-1", { x: "hi" }, signal, undefined, ctx);

		expect(execute).toHaveBeenCalledWith({ x: "hi" }, { signal, ctx });
		expect(result.content[0]).toEqual({ type: "text", text: "got hi" });
		expect(result.details).toBe(2);
	});
});
