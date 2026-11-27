/**
 * Tests for the /manage_context argument parsing: the optional `auto`
 * argument that runs the context-autoselect subagent right away, and the
 * `config` subcommand that sets the context-window limit.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseAutoArgs, registerCommands } from "../src/commands.ts";
import { loadState } from "../src/state.ts";
import { makeHarness } from "./helpers.ts";

type CommandHandler = (args: string, ctx: never) => Promise<void>;

/** Register the commands on a harness pi (appendEntry-backed) and return the /manage_context handler. */
function setup() {
	const entries: SessionEntry[] = [];
	const { pi: basePi, ctx, notifies } = makeHarness(entries);
	const registerCommand = vi.fn();
	const pi = Object.assign(basePi, { registerCommand }) as unknown as ExtensionAPI;
	registerCommands(pi, () => []);
	const cmd = registerCommand.mock.calls.find((c) => c[0] === "manage_context")![1] as { handler: CommandHandler };
	return { handler: cmd.handler, ctx, notifies, entries };
}

describe("parseAutoArgs (/manage_context auto)", () => {
	it("parses bare 'auto' with no focus", () => {
		expect(parseAutoArgs("auto")).toEqual({});
		expect(parseAutoArgs("  auto  ")).toEqual({});
	});

	it("parses 'auto' followed by a focus description", () => {
		expect(parseAutoArgs("auto fix the login bug")).toEqual({ focus: "fix the login bug" });
		expect(parseAutoArgs("auto   multiple   spaces ")).toEqual({ focus: "multiple   spaces" });
	});

	it("returns null for non-auto args (picker, model, model set)", () => {
		expect(parseAutoArgs("")).toBeNull();
		expect(parseAutoArgs("model")).toBeNull();
		expect(parseAutoArgs("anthropic/claude-haiku-4-5")).toBeNull();
		expect(parseAutoArgs("autocomplete")).toBeNull();
	});
});

describe("registerCommands", () => {
	it("registers /mc as an alias sharing the /manage_context definition", () => {
		const registerCommand = vi.fn();
		const pi = { registerCommand } as unknown as ExtensionAPI;

		registerCommands(pi, () => []);

		const names = registerCommand.mock.calls.map((c) => c[0]);
		expect(names).toContain("manage_context");
		expect(names).toContain("mc");
		const manageContext = registerCommand.mock.calls.find((c) => c[0] === "manage_context")![1];
		const mc = registerCommand.mock.calls.find((c) => c[0] === "mc")![1];
		expect(mc).toBe(manageContext);
	});
});

describe("/mc config subcommand", () => {
	it("'config off' persists a null windowConfig and notifies", async () => {
		const { handler, ctx, notifies } = setup();
		await handler("config off", ctx as never);
		expect(loadState(ctx).windowConfig).toEqual({ mode: null, window: null });
		expect(notifies.at(-1)).toContain("off");
	});

	it("'config tool 10' persists { mode: tool, window: 10 } and notifies", async () => {
		const { handler, ctx, notifies } = setup();
		await handler("config tool 10", ctx as never);
		expect(loadState(ctx).windowConfig).toEqual({ mode: "tool", window: 10 });
		expect(notifies.at(-1)).toContain("tool ≤ 10");
	});

	it("invalid args notify an error and persist nothing", async () => {
		const { handler, ctx, notifies, entries } = setup();
		await handler("config tool banana", ctx as never);
		expect(notifies.at(-1)).toContain("mc config:");
		expect(loadState(ctx).windowConfig).toBeUndefined();
		expect(entries).toHaveLength(0);
	});

	it("bare 'config' without a UI warns instead of opening a dialogue", async () => {
		const { handler, ctx, notifies, entries } = setup();
		await handler("config", ctx as never);
		expect(notifies.at(-1)).toContain("interactive terminal");
		expect(entries).toHaveLength(0);
	});
});
