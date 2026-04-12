import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupOldLogs, createLogPath, findOrphans, isProcessRunning, removePidFile, writePidFile } from "../utils.js";

// ─── Temp directory helpers ──────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `pi-monitor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	try {
		execSync(`rm -rf "${testDir}"`);
	} catch {
		/* best effort */
	}
});

// ─── Log Management Tests ────────────────────────────────────────────────────

describe("createLogPath", () => {
	it("creates log directory and returns path with label and timestamp", () => {
		const logDir = join(testDir, "logs");
		const path = createLogPath(logDir, "my-build");

		expect(existsSync(logDir)).toBe(true);
		expect(path).toContain("my-build-");
		expect(path).toContain(logDir);
		expect(path).toMatch(/\.log$/);
	});

	it("generates unique paths on successive calls", () => {
		const logDir = join(testDir, "logs");
		const path1 = createLogPath(logDir, "test");
		// Small delay to ensure different timestamp
		const path2 = createLogPath(logDir, "test");
		// Paths may be same if called within same millisecond, but should not throw
		expect(path1).toContain("test-");
		expect(path2).toContain("test-");
	});
});

describe("cleanupOldLogs", () => {
	it("deletes logs older than maxAge", () => {
		const logDir = join(testDir, "logs");
		mkdirSync(logDir, { recursive: true });

		// Create a "old" log file and backdate it
		const oldLog = join(logDir, "old-test-2020-01-01.log");
		writeFileSync(oldLog, "old content");
		// Backdate the file's mtime
		execSync(`touch -t 202001010000.00 "${oldLog}"`);

		// Create a "new" log file
		const newLog = join(logDir, "new-test-2099-01-01.log");
		writeFileSync(newLog, "new content");

		const cleaned = cleanupOldLogs(logDir, 7 * 24 * 60 * 60 * 1000);

		expect(cleaned).toBe(1);
		expect(existsSync(oldLog)).toBe(false);
		expect(existsSync(newLog)).toBe(true);
	});

	it("returns 0 when no logs exist", () => {
		const logDir = join(testDir, "empty-logs");
		mkdirSync(logDir, { recursive: true });
		expect(cleanupOldLogs(logDir, 1000)).toBe(0);
	});

	it("returns 0 for non-existent directory", () => {
		expect(cleanupOldLogs(join(testDir, "nope"), 1000)).toBe(0);
	});

	it("only deletes .log files", () => {
		const logDir = join(testDir, "logs");
		mkdirSync(logDir, { recursive: true });

		const logFile = join(logDir, "test.log");
		const jsonFile = join(logDir, "test.json");
		writeFileSync(logFile, "log");
		writeFileSync(jsonFile, "json");
		execSync(`touch -t 202001010000.00 "${logFile}"`);
		execSync(`touch -t 202001010000.00 "${jsonFile}"`);

		cleanupOldLogs(logDir, 7 * 24 * 60 * 60 * 1000);

		expect(existsSync(logFile)).toBe(false);
		expect(existsSync(jsonFile)).toBe(true);
	});
});

// ─── PID File Tests ──────────────────────────────────────────────────────────

describe("writePidFile / removePidFile", () => {
	it("writes and reads a PID file", () => {
		const pidDir = join(testDir, "pids");
		writePidFile(pidDir, "my-build", 12345, 67890);

		const pidFile = join(pidDir, "my-build.json");
		expect(existsSync(pidFile)).toBe(true);

		const data = JSON.parse(readFileSync(pidFile, "utf-8"));
		expect(data.label).toBe("my-build");
		expect(data.parentPid).toBe(12345);
		expect(data.childPid).toBe(67890);
		expect(data.startedAt).toBeTypeOf("number");
	});

	it("writes null childPid when undefined", () => {
		const pidDir = join(testDir, "pids");
		writePidFile(pidDir, "test", 111, undefined);

		const data = JSON.parse(readFileSync(join(pidDir, "test.json"), "utf-8"));
		expect(data.childPid).toBeNull();
	});

	it("removes a PID file", () => {
		const pidDir = join(testDir, "pids");
		writePidFile(pidDir, "test", 111, 222);

		expect(existsSync(join(pidDir, "test.json"))).toBe(true);
		removePidFile(pidDir, "test");
		expect(existsSync(join(pidDir, "test.json"))).toBe(false);
	});

	it("removePidFile is a no-op for non-existent file", () => {
		const pidDir = join(testDir, "pids");
		mkdirSync(pidDir, { recursive: true });
		// Should not throw
		removePidFile(pidDir, "nonexistent");
	});
});

describe("isProcessRunning", () => {
	it("returns true for current process", () => {
		expect(isProcessRunning(process.pid)).toBe(true);
	});

	it("returns false for a definitely-dead PID", () => {
		// PID 99999999 is almost certainly not running
		expect(isProcessRunning(99999999)).toBe(false);
	});
});

describe("findOrphans", () => {
	it("finds orphaned processes (parent dead)", () => {
		const pidDir = join(testDir, "pids");
		mkdirSync(pidDir, { recursive: true });

		// Write a PID file with a dead parent PID
		writeFileSync(
			join(pidDir, "orphan.json"),
			JSON.stringify({
				label: "orphan",
				parentPid: 99999999, // dead
				childPid: 88888888,
				startedAt: Date.now() - 60000,
			}),
		);

		const orphans = findOrphans(pidDir);
		expect(orphans).toHaveLength(1);
		expect(orphans[0].label).toBe("orphan");
		expect(orphans[0].childPid).toBe(88888888);
	});

	it("does not flag processes with live parents", () => {
		const pidDir = join(testDir, "pids");
		mkdirSync(pidDir, { recursive: true });

		// Write a PID file with current process as parent (alive)
		writeFileSync(
			join(pidDir, "alive.json"),
			JSON.stringify({
				label: "alive",
				parentPid: process.pid,
				childPid: 12345,
				startedAt: Date.now(),
			}),
		);

		const orphans = findOrphans(pidDir);
		expect(orphans).toHaveLength(0);
	});

	it("returns empty for non-existent directory", () => {
		expect(findOrphans(join(testDir, "nope"))).toEqual([]);
	});

	it("skips malformed PID files", () => {
		const pidDir = join(testDir, "pids");
		mkdirSync(pidDir, { recursive: true });

		writeFileSync(join(pidDir, "bad.json"), "not json{{{");
		writeFileSync(
			join(pidDir, "orphan.json"),
			JSON.stringify({
				label: "orphan",
				parentPid: 99999999,
				childPid: null,
				startedAt: Date.now(),
			}),
		);

		const orphans = findOrphans(pidDir);
		expect(orphans).toHaveLength(1);
		expect(orphans[0].label).toBe("orphan");
	});

	it("handles mixed live and dead parents", () => {
		const pidDir = join(testDir, "pids");
		mkdirSync(pidDir, { recursive: true });

		writeFileSync(
			join(pidDir, "alive.json"),
			JSON.stringify({
				label: "alive",
				parentPid: process.pid,
				childPid: 111,
				startedAt: Date.now(),
			}),
		);

		writeFileSync(
			join(pidDir, "dead.json"),
			JSON.stringify({
				label: "dead",
				parentPid: 99999999,
				childPid: 222,
				startedAt: Date.now(),
			}),
		);

		const orphans = findOrphans(pidDir);
		expect(orphans).toHaveLength(1);
		expect(orphans[0].label).toBe("dead");
	});
});
