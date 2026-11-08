/**
 * context-select — the agent-facing counterpart to the picker's Space key:
 * mark turn units selected (visible to the model again) by groupId.
 *
 * Thin wrapper: all logic lives in the shared buildContextMarkTool() adapter
 * and the pure runContextMark() in context-mark.ts.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { CONTEXT_SELECT_PARAMETERS, CONTEXT_SELECT_TOOL_DEFINITION } from "../tool_definitions/context-select.ts";
import { buildContextMarkTool } from "./context-mark.ts";

export function buildContextSelectTool(pi: ExtensionAPI): ToolDefinition<typeof CONTEXT_SELECT_PARAMETERS, unknown> {
	return buildContextMarkTool(pi, CONTEXT_SELECT_TOOL_DEFINITION, "select");
}

export function registerContextSelectTool(pi: ExtensionAPI): void {
	pi.registerTool(buildContextSelectTool(pi));
}
