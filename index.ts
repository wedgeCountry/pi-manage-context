/**
 * manage-context — review, select, compress, or delete messages before
 * they're sent to the model.
 *
 * Usage:
 *   /manage_context                      open the picker
 *   /manage_context <provider>/<modelId> set the compression model, then open the picker
 *   /manage_context model                print the currently configured compression model
 *   /export_context [filename.md]        write the summarized context as a markdown file to the current dir
 *   /toggle-read-hook                    toggle the read tool's post-execution hook (default: off)
 *
 * Keys inside the picker:
 *   Up/Down, PageUp/PageDown   navigate
 *   Space                      toggle selected / unselected
 *   c                          toggle "marked for compression"
 *   d                          toggle "marked for deletion"
 *   Enter                      preview the full content of the highlighted row
 *   Esc                        apply the marks (compress/delete) and close;
 *                              if any entries are marked for deletion and/or
 *                              compression, asks for confirmation (y/enter
 *                              confirm, n/esc cancel). Confirmed deletions are
 *                              permanent: gone from the model's context AND
 *                              hidden from this picker for good — there's no
 *                              "undelete". Confirmed compressions replace the
 *                              original messages with the generated summary
 *                              and the entry's state reverts to "selected".
 *   Ctrl+C                     cancel — discard any unsaved marks from this session
 *
 * Install: copy this directory to ~/.pi/agent/extensions/manage-context/
 * (or .pi/extensions/ for a single project). Pi auto-discovers directories
 * with an index.ts entry point.
 *
 * Grounded against @earendil-works/pi-coding-agent, @earendil-works/pi-ai and
 * @earendil-works/pi-tui — see the real .d.ts files shipped with those
 * packages for anything not covered by a comment here.
 *
 * This file is pure wiring: session hooks live in src/hooks.ts, slash commands
 * in src/commands.ts, tools in src/tools/, and the picker UI in src/view.ts
 * (render) + src/picker/picker-view-model.ts (behavior).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommands } from "./src/commands.ts";
import { registerHooks } from "./src/hooks.ts";
import { registerManageContextSelectTool, registerManageContextTool } from "./src/tools/manage-context.ts";
import { registerViewContextTool } from "./src/tools/view-context.ts";

// Re-exported for the tests in tests/index.test.ts.
export { unitHasMatchingRead, unitHasMatchingToolCallId } from "./src/hooks.ts";

export default function (pi: ExtensionAPI): void {
	let cachedModels: Model<Api>[] = [];

	pi.on("session_start", async (_event, ctx) => {
		cachedModels = ctx.modelRegistry.getAvailable();
	});

	registerHooks(pi);
	registerManageContextSelectTool(pi);
	registerManageContextTool(pi);
	registerViewContextTool(pi);
	registerCommands(pi, () => cachedModels);
}
