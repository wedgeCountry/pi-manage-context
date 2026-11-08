/**
 * Tests for the /manage_context argument parsing: the optional `auto`
 * argument that runs the context-autoselect subagent right away.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseAutoArgs, registerCommands } from "../src/commands.ts";

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
