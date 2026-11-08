/**
 * context-unselect — hide turn units from the model's context by groupId.
 *
 * Thin wrapper: all logic lives in the shared buildContextMarkTool() adapter
 * and the pure runContextMark() in context-mark.ts. This tool is also the ONLY
 * tool given to the context-autoselect subagent, so autoselect can hide units
 * but never select, compress, or delete them.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { CONTEXT_UNSELECT_PARAMETERS, CONTEXT_UNSELECT_TOOL_DEFINITION } from "../tool_definitions/context-unselect.ts";
import { buildContextMarkTool } from "./context-mark.ts";

export function buildContextUnselectTool(pi: ExtensionAPI): ToolDefinition<typeof CONTEXT_UNSELECT_PARAMETERS, string[]> {
	return buildContextMarkTool(pi, CONTEXT_UNSELECT_TOOL_DEFINITION, "unselect");
}

export function registerContextUnselectTool(pi: ExtensionAPI): void {
	pi.registerTool(buildContextUnselectTool(pi));
}
