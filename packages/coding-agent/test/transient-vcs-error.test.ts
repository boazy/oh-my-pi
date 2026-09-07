/**
 * Contract for {@link isTransientVcsError}: which rejection shapes count as
 * a transient cancellation (retry-later) versus a genuine backend failure
 * (fail-over). The native shape mirrors `repo_blocking`'s `rich_error`
 * mapping (`{ name: "VcsError", code: <Error::kind> }`); note the binding
 * spells cancellation with one L (`Canceled`), so the napi `Status`
 * spelling (`Cancelled`) must NOT match.
 */
import { describe, expect, it } from "bun:test";
import { isTransientVcsError } from "@oh-my-pi/pi-coding-agent/modes/shared";

describe("isTransientVcsError", () => {
	it("treats the native cancellation shape as transient", () => {
		expect(isTransientVcsError({ name: "VcsError", code: "Canceled" })).toBe(true);
	});

	it("treats DOM abort/timeout names as transient", () => {
		expect(isTransientVcsError({ name: "AbortError" })).toBe(true);
		expect(isTransientVcsError({ name: "TimeoutError" })).toBe(true);
	});

	it("treats genuine backend failures as non-transient", () => {
		expect(isTransientVcsError({ name: "VcsError", code: "Backend" })).toBe(false);
		expect(isTransientVcsError({ name: "VcsError", code: "Io" })).toBe(false);
		// One L is ours; two Ls is not.
		expect(isTransientVcsError({ name: "VcsError", code: "Cancelled" })).toBe(false);
		expect(isTransientVcsError(new Error("store gone"))).toBe(false);
		expect(isTransientVcsError(null)).toBe(false);
		expect(isTransientVcsError(undefined)).toBe(false);
	});
});
