/**
 * Tests for the /manage_context argument parsing: the optional `auto`
 * argument that runs the context-autoselect subagent right away.
 */
import { describe, expect, it } from "vitest";
import { parseAutoArgs } from "../src/commands.ts";

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
