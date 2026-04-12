import { describe, expect, it } from "vitest";
import {
	bufferOutput,
	buildCompletionMessage,
	buildHeartbeatStatus,
	buildWidgetLines,
	calculateBackoff,
	createMonitorEntry,
	formatDuration,
	formatListEntry,
	getTail,
	matchesAnyPattern,
	sanitizeLabel,
	shouldRetry,
} from "../utils.js";

describe("formatDuration", () => {
	it("formats seconds", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(5000)).toBe("5s");
		expect(formatDuration(59000)).toBe("59s");
	});

	it("formats minutes and seconds", () => {
		expect(formatDuration(60000)).toBe("1m");
		expect(formatDuration(90000)).toBe("1m 30s");
		expect(formatDuration(3599000)).toBe("59m 59s");
	});

	it("formats hours and minutes", () => {
		expect(formatDuration(3600000)).toBe("1h");
		expect(formatDuration(5400000)).toBe("1h 30m");
		expect(formatDuration(7200000)).toBe("2h");
	});

	it("drops zero remainders", () => {
		expect(formatDuration(120000)).toBe("2m");
		expect(formatDuration(7200000)).toBe("2h");
	});
});

describe("bufferOutput", () => {
	it("splits data into lines and appends to buffer", () => {
		const entry = createMonitorEntry({ label: "test", command: "echo hi" });
		bufferOutput(entry, "line1\nline2\nline3");
		expect(entry.outputBuffer).toEqual(["line1", "line2", "line3"]);
	});

	it("appends across multiple calls", () => {
		const entry = createMonitorEntry({ label: "test", command: "echo hi" });
		bufferOutput(entry, "a\nb");
		bufferOutput(entry, "c\nd");
		expect(entry.outputBuffer).toEqual(["a", "b", "c", "d"]);
	});

	it("respects maxBufferLines by evicting oldest lines", () => {
		const entry = createMonitorEntry({
			label: "test",
			command: "echo hi",
			maxBufferLines: 3,
		});
		bufferOutput(entry, "1\n2\n3\n4\n5");
		expect(entry.outputBuffer).toEqual(["3", "4", "5"]);
	});

	it("handles empty data", () => {
		const entry = createMonitorEntry({ label: "test", command: "echo hi" });
		bufferOutput(entry, "");
		expect(entry.outputBuffer).toEqual([""]);
	});
});

describe("getTail", () => {
	it("returns last N lines", () => {
		const entry = createMonitorEntry({ label: "test", command: "echo hi" });
		entry.outputBuffer = ["a", "b", "c", "d", "e"];
		expect(getTail(entry, 3)).toBe("c\nd\ne");
	});

	it("returns all lines when N exceeds buffer", () => {
		const entry = createMonitorEntry({ label: "test", command: "echo hi" });
		entry.outputBuffer = ["a", "b"];
		expect(getTail(entry, 10)).toBe("a\nb");
	});

	it("uses entry.tailLines as default", () => {
		const entry = createMonitorEntry({
			label: "test",
			command: "echo hi",
			tailLines: 2,
		});
		entry.outputBuffer = ["a", "b", "c", "d"];
		expect(getTail(entry)).toBe("c\nd");
	});

	it("trims trailing whitespace", () => {
		const entry = createMonitorEntry({ label: "test", command: "echo hi" });
		entry.outputBuffer = ["a", "b", "  "];
		expect(getTail(entry, 3)).toBe("a\nb");
	});

	it("returns empty string for empty buffer", () => {
		const entry = createMonitorEntry({ label: "test", command: "echo hi" });
		expect(getTail(entry, 5)).toBe("");
	});
});

describe("sanitizeLabel", () => {
	it("passes through valid labels", () => {
		expect(sanitizeLabel("my-build")).toBe("my-build");
		expect(sanitizeLabel("test_123")).toBe("test_123");
	});

	it("replaces spaces and special chars with underscore", () => {
		expect(sanitizeLabel("my build")).toBe("my_build");
		expect(sanitizeLabel("test@#$%")).toBe("test____");
	});

	it("handles empty string", () => {
		expect(sanitizeLabel("")).toBe("");
	});
});

describe("calculateBackoff", () => {
	it("doubles each retry from base", () => {
		expect(calculateBackoff(1, 2000, 60000)).toBe(2000);
		expect(calculateBackoff(2, 2000, 60000)).toBe(4000);
		expect(calculateBackoff(3, 2000, 60000)).toBe(8000);
		expect(calculateBackoff(4, 2000, 60000)).toBe(16000);
	});

	it("caps at maxMs", () => {
		expect(calculateBackoff(10, 2000, 60000)).toBe(60000);
		expect(calculateBackoff(100, 2000, 60000)).toBe(60000);
	});

	it("works with small base", () => {
		expect(calculateBackoff(1, 100, 1000)).toBe(100);
		expect(calculateBackoff(4, 100, 1000)).toBe(800);
		expect(calculateBackoff(5, 100, 1000)).toBe(1000);
	});
});

describe("matchesAnyPattern", () => {
	it("returns matched pattern on match", () => {
		expect(matchesAnyPattern("CREATE_COMPLETE", ["CREATE_COMPLETE", "UPDATE_COMPLETE"])).toBe("CREATE_COMPLETE");
	});

	it("returns first match when multiple match", () => {
		expect(matchesAnyPattern("COMPLETE stuff", ["COMPLETE", "stuff"])).toBe("COMPLETE");
	});

	it("returns null on no match", () => {
		expect(matchesAnyPattern("IN_PROGRESS", ["COMPLETE", "FAILED"])).toBeNull();
	});

	it("handles empty patterns array", () => {
		expect(matchesAnyPattern("anything", [])).toBeNull();
	});

	it("handles empty output", () => {
		expect(matchesAnyPattern("", ["COMPLETE"])).toBeNull();
	});

	it("does substring matching", () => {
		expect(matchesAnyPattern("Status: CREATE_COMPLETE (stack ready)", ["CREATE_COMPLETE"])).toBe("CREATE_COMPLETE");
	});
});

describe("createMonitorEntry", () => {
	it("creates entry with defaults", () => {
		const entry = createMonitorEntry({ label: "test", command: "echo hi" });
		expect(entry.label).toBe("test");
		expect(entry.command).toBe("echo hi");
		expect(entry.mode).toBe("watch");
		expect(entry.maxBufferLines).toBe(5000);
		expect(entry.tailLines).toBe(100);
		expect(entry.maxRetries).toBe(0);
		expect(entry.retryCount).toBe(0);
		expect(entry.finished).toBe(false);
		expect(entry.exitCode).toBeNull();
	});

	it("allows overriding any field", () => {
		const entry = createMonitorEntry({
			label: "poll",
			command: "check status",
			mode: "poll",
			maxRetries: 3,
			pollInterval: 10,
			untilPatterns: ["DONE"],
		});
		expect(entry.mode).toBe("poll");
		expect(entry.maxRetries).toBe(3);
		expect(entry.pollInterval).toBe(10);
		expect(entry.untilPatterns).toEqual(["DONE"]);
	});
});

// ─── Extracted Logic from index.ts ───────────────────────────────────────────

describe("shouldRetry", () => {
	it("returns true for watch mode with retries remaining and non-zero exit", () => {
		expect(shouldRetry({ mode: "watch", retryCount: 0, maxRetries: 3 }, 1)).toBe(true);
	});

	it("returns false for poll mode", () => {
		expect(shouldRetry({ mode: "poll", retryCount: 0, maxRetries: 3 }, 1)).toBe(false);
	});

	it("returns false for exit code 0 (success)", () => {
		expect(shouldRetry({ mode: "watch", retryCount: 0, maxRetries: 3 }, 0)).toBe(false);
	});

	it("returns false for null exit code", () => {
		expect(shouldRetry({ mode: "watch", retryCount: 0, maxRetries: 3 }, null)).toBe(false);
	});

	it("returns false when retries exhausted", () => {
		expect(shouldRetry({ mode: "watch", retryCount: 3, maxRetries: 3 }, 1)).toBe(false);
	});

	it("returns false when cancelled by user", () => {
		expect(shouldRetry({ mode: "watch", retryCount: 0, maxRetries: 3 }, 130, "Cancelled by user")).toBe(false);
	});

	it("returns false on pattern match reason", () => {
		expect(shouldRetry({ mode: "watch", retryCount: 0, maxRetries: 3 }, 1, "Matched completion pattern: DONE")).toBe(
			false,
		);
	});

	it("returns false when maxRetries is 0", () => {
		expect(shouldRetry({ mode: "watch", retryCount: 0, maxRetries: 0 }, 1)).toBe(false);
	});

	it("returns true on retry 2 of 3", () => {
		expect(shouldRetry({ mode: "watch", retryCount: 2, maxRetries: 3 }, 1)).toBe(true);
	});
});

describe("buildHeartbeatStatus", () => {
	it("builds basic watch mode status", () => {
		const entry = createMonitorEntry({ label: "build", command: "make", startTime: Date.now() - 5000 });
		const status = buildHeartbeatStatus(entry);
		expect(status).toContain("🔄 build");
		expect(status).toContain("running");
		expect(status).toContain("0 lines");
	});

	it("includes retry info when retrying", () => {
		const entry = createMonitorEntry({
			label: "build",
			command: "make",
			retryCount: 2,
			maxRetries: 5,
		});
		const status = buildHeartbeatStatus(entry);
		expect(status).toContain("(retry 2/5)");
	});

	it("includes poll count for poll mode", () => {
		const entry = createMonitorEntry({
			label: "deploy",
			command: "check",
			mode: "poll",
			pollCount: 7,
		});
		const status = buildHeartbeatStatus(entry);
		expect(status).toContain("poll #7");
	});

	it("includes last poll output when available", () => {
		const entry = createMonitorEntry({
			label: "deploy",
			command: "check",
			mode: "poll",
			pollCount: 3,
			lastPollOutput: "Status: IN_PROGRESS\nStack: my-stack",
		});
		const status = buildHeartbeatStatus(entry);
		expect(status).toContain("Last: `Stack: my-stack`");
	});

	it("includes last output line for watch mode", () => {
		const entry = createMonitorEntry({ label: "build", command: "make" });
		entry.outputBuffer = ["compiling...", "linking...", "done"];
		const status = buildHeartbeatStatus(entry);
		expect(status).toContain("Last: `done`");
	});

	it("truncates long last lines to 120 chars", () => {
		const entry = createMonitorEntry({
			label: "deploy",
			command: "check",
			mode: "poll",
			pollCount: 1,
			lastPollOutput: "x".repeat(200),
		});
		const status = buildHeartbeatStatus(entry);
		// The last line in the status should be truncated
		const lastMatch = status.match(/Last: `(.+)`/);
		expect(lastMatch).toBeTruthy();
		expect(lastMatch![1].length).toBeLessThanOrEqual(120);
	});

	it("handles poll mode with empty last poll output", () => {
		const entry = createMonitorEntry({
			label: "deploy",
			command: "check",
			mode: "poll",
			pollCount: 2,
			lastPollOutput: "  \n  ",
		});
		const status = buildHeartbeatStatus(entry);
		expect(status).toContain("poll #2");
		// Empty trimmed lines should not produce a "Last:" line
		expect(status).not.toContain("Last:");
	});

	it("handles poll mode with undefined pollCount", () => {
		const entry = createMonitorEntry({
			label: "deploy",
			command: "check",
			mode: "poll",
		});
		entry.pollCount = undefined;
		const status = buildHeartbeatStatus(entry);
		expect(status).toContain("poll #0");
	});

	it("handles watch mode with empty buffer", () => {
		const entry = createMonitorEntry({ label: "build", command: "make" });
		entry.outputBuffer = [];
		const status = buildHeartbeatStatus(entry);
		expect(status).toContain("0 lines");
		expect(status).not.toContain("Last:");
	});
});

describe("buildCompletionMessage", () => {
	it("builds success message", () => {
		const entry = createMonitorEntry({
			label: "tests",
			command: "npm test",
			logPath: "/tmp/tests.log",
		});
		const msg = buildCompletionMessage(entry, 0);
		expect(msg).toContain("✅");
		expect(msg).toContain("completed successfully");
		expect(msg).toContain("npm test");
		expect(msg).toContain("Exit code:** 0");
		expect(msg).toContain("/tmp/tests.log");
	});

	it("builds failure message", () => {
		const entry = createMonitorEntry({
			label: "build",
			command: "make",
			error: "Process crashed",
			logPath: "/tmp/build.log",
		});
		const msg = buildCompletionMessage(entry, 1);
		expect(msg).toContain("❌");
		expect(msg).toContain("failed");
		expect(msg).toContain("Process crashed");
	});

	it("includes reason when provided", () => {
		const entry = createMonitorEntry({ label: "deploy", command: "check", logPath: "/tmp/d.log" });
		const msg = buildCompletionMessage(entry, 0, "Matched completion pattern: DONE");
		expect(msg).toContain("Matched completion pattern: DONE");
	});

	it("includes retry info", () => {
		const entry = createMonitorEntry({
			label: "flaky",
			command: "test",
			retryCount: 2,
			maxRetries: 3,
			logPath: "/tmp/f.log",
		});
		const msg = buildCompletionMessage(entry, 0);
		expect(msg).toContain("Retries:** 2/3");
	});

	it("includes poll count for poll mode", () => {
		const entry = createMonitorEntry({
			label: "poll",
			command: "check",
			mode: "poll",
			pollCount: 15,
			logPath: "/tmp/p.log",
		});
		const msg = buildCompletionMessage(entry, 0);
		expect(msg).toContain("Polls:** 15");
	});

	it("includes tail output when buffer has content", () => {
		const entry = createMonitorEntry({
			label: "build",
			command: "make",
			tailLines: 5,
			logPath: "/tmp/b.log",
		});
		entry.outputBuffer = ["line1", "line2", "line3"];
		const msg = buildCompletionMessage(entry, 0);
		expect(msg).toContain("```");
		expect(msg).toContain("line1");
	});

	it("skips tail section when buffer is empty", () => {
		const entry = createMonitorEntry({
			label: "build",
			command: "make",
			logPath: "/tmp/b.log",
		});
		const msg = buildCompletionMessage(entry, 1);
		expect(msg).not.toContain("```");
	});
});

describe("buildWidgetLines", () => {
	it("returns null when no active monitors", () => {
		expect(buildWidgetLines([])).toBeNull();
		expect(
			buildWidgetLines([
				{
					label: "done",
					mode: "watch",
					startTime: Date.now(),
					pollCount: 0,
					retryCount: 0,
					maxRetries: 0,
					finished: true,
				},
			]),
		).toBeNull();
	});

	it("builds lines for active monitors", () => {
		const lines = buildWidgetLines([
			{
				label: "build",
				mode: "watch",
				startTime: Date.now() - 5000,
				pollCount: 0,
				retryCount: 0,
				maxRetries: 0,
				finished: false,
			},
		]);
		expect(lines).toBeTruthy();
		expect(lines![0]).toBe("📡 Monitors:");
		expect(lines![1]).toContain("🔄 build");
	});

	it("shows poll count for poll mode", () => {
		const lines = buildWidgetLines([
			{
				label: "deploy",
				mode: "poll",
				startTime: Date.now(),
				pollCount: 5,
				retryCount: 0,
				maxRetries: 0,
				finished: false,
			},
		]);
		expect(lines![1]).toContain("⟳5");
	});

	it("defaults pollCount to 0 when undefined", () => {
		const lines = buildWidgetLines([
			{
				label: "deploy",
				mode: "poll",
				startTime: Date.now(),
				pollCount: undefined as any,
				retryCount: 0,
				maxRetries: 0,
				finished: false,
			},
		]);
		expect(lines![1]).toContain("⟳0");
	});

	it("shows retry info", () => {
		const lines = buildWidgetLines([
			{
				label: "test",
				mode: "watch",
				startTime: Date.now(),
				pollCount: 0,
				retryCount: 2,
				maxRetries: 3,
				finished: false,
			},
		]);
		expect(lines![1]).toContain("♻2/3");
	});

	it("filters out finished monitors", () => {
		const lines = buildWidgetLines([
			{
				label: "done",
				mode: "watch",
				startTime: Date.now(),
				pollCount: 0,
				retryCount: 0,
				maxRetries: 0,
				finished: true,
			},
			{
				label: "active",
				mode: "watch",
				startTime: Date.now(),
				pollCount: 0,
				retryCount: 0,
				maxRetries: 0,
				finished: false,
			},
		]);
		expect(lines).toHaveLength(2); // header + 1 active
		expect(lines![1]).toContain("active");
	});
});

describe("formatListEntry", () => {
	it("formats running watch entry", () => {
		const entry = createMonitorEntry({
			label: "build",
			command: "make all",
			logPath: "/tmp/build.log",
		});
		const text = formatListEntry(entry);
		expect(text).toContain("🔄 running");
		expect(text).toContain("build");
		expect(text).toContain("watch");
		expect(text).toContain("make all");
		expect(text).toContain("/tmp/build.log");
	});

	it("formats completed entry", () => {
		const entry = createMonitorEntry({
			label: "test",
			command: "npm test",
			finished: true,
			exitCode: 0,
			logPath: "/tmp/t.log",
		});
		const text = formatListEntry(entry);
		expect(text).toContain("✅ completed");
	});

	it("formats failed entry", () => {
		const entry = createMonitorEntry({
			label: "test",
			command: "npm test",
			finished: true,
			exitCode: 1,
			logPath: "/tmp/t.log",
		});
		const text = formatListEntry(entry);
		expect(text).toContain("❌ failed (exit 1)");
	});

	it("includes poll count for poll mode", () => {
		const entry = createMonitorEntry({
			label: "deploy",
			command: "check",
			mode: "poll",
			pollCount: 12,
			logPath: "/tmp/d.log",
		});
		const text = formatListEntry(entry);
		expect(text).toContain("polls: 12");
	});

	it("includes retry info when retries occurred", () => {
		const entry = createMonitorEntry({
			label: "flaky",
			command: "test",
			retryCount: 1,
			maxRetries: 3,
			logPath: "/tmp/f.log",
		});
		const text = formatListEntry(entry);
		expect(text).toContain("retries: 1/3");
	});

	it("omits retry info when no retries", () => {
		const entry = createMonitorEntry({
			label: "build",
			command: "make",
			logPath: "/tmp/b.log",
		});
		const text = formatListEntry(entry);
		expect(text).not.toContain("retries:");
	});
});
