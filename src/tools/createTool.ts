/**
 * Shared tool factory, mimicking the tool-definition pattern used by
 * pi-small-models (its src/backend/createTool.ts): a tool is its static
 * definition from src/tool_definitions/ plus hooks. createTool() spreads the
 * definition and adapts pi's execute(toolCallId, params, signal, onUpdate,
 * ctx) signature into the hooks' simpler execute(params, { signal, ctx }),
 * so each tool's logic never repeats the framework plumbing.
 *
 * Domain logic still lives in plain, ExtensionContext-free functions (see
 * context-mark.ts, context-autoselect-engine.ts, view-context.ts); the hooks
 * below are the thin adapters that fetch session entries/state and call them.
 */

import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

export interface ToolHooks<TParams, TDetails = unknown> {
	/** Runs the tool. `params` are the schema-validated arguments. */
	execute: (
		params: TParams,
		env: { signal: AbortSignal | undefined; ctx: ExtensionContext },
	) => Promise<AgentToolResult<TDetails>> | AgentToolResult<TDetails>;
}

export function createTool<TParams extends TSchema, TDetails = unknown>(
	definition: Omit<ToolDefinition<TParams, TDetails>, "execute">,
	hooks: ToolHooks<Static<TParams>, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return {
		...definition,
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			return hooks.execute(params, { signal, ctx });
		},
	};
}
