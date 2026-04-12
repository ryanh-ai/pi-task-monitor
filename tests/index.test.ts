/**
 * Tests for index.ts — the extension entry point.
 *
 * Strategy: mock the ExtensionAPI, call the default export to register tools,
 * then exercise the tool execute handlers and lifecycle hooks directly.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock pi dependencies BEFORE importing index ────────────────────────────

vi.mock("@mariozechner/pi-ai", () => ({
	StringEnum: (...args: any[]) => ({ type: "string", enum: args[0] }),
}));

vi.mock("@mariozechner/pi-tui", () => ({
	Text: class MockText {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
	},
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;
let tools: Map<string, any>;
// biome-ignore lint/complexity/noBannedTypes: test mock maps need generic callable
let eventHandlers: Map<string, Function>;
// biome-ignore lint/complexity/noBannedTypes: test mock maps need generic callable
let messageRenderers: Map<string, Function>;
let mockPi: any;
let mockCtx: any;

function createMockPi() {
	tools = new Map();
	eventHandlers = new Map();
	messageRenderers = new Map();

	return {
		sendMessage: vi.fn(),
		// biome-ignore lint/complexity/noBannedTypes: test mock
		on: vi.fn((event: string, handler: Function) => {
			eventHandlers.set(event, handler);
		}),
		registerTool: vi.fn((toolDef: any) => {
			tools.set(toolDef.name, toolDef);
		}),
		// biome-ignore lint/complexity/noBannedTypes: test mock
		registerMessageRenderer: vi.fn((type: string, renderer: Function) => {
			messageRenderers.set(type, renderer);
		}),
	};
}

function createMockCtx(cwd: string) {
	return {
		cwd,
		ui: {
			setWidget: vi.fn(),
			notify: vi.fn(),
			confirm: vi.fn().mockResolvedValue(false),
		},
	};
}

async function executeTool(name: string, params: any, ctx?: any) {
	const tool = tools.get(name);
	if (!tool) throw new Error(`Tool '${name}' not registered`);
	return tool.execute("test-call-id", params, new AbortController().signal, vi.fn(), ctx ?? mockCtx);
}

/** Wait for a monitor to finish (polls every 50ms, up to timeout) */
async function waitForFinish(label: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		// Check if sendMessage was called with a completion message for this label
		const calls = mockPi.sendMessage.mock.calls;
		const found = calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === label,
		);
		if (found) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Monitor '${label}' did not finish within ${timeoutMs}ms`);
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
	testDir = join(tmpdir(), `pi-monitor-idx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });

	mockPi = createMockPi();
	mockCtx = createMockCtx(testDir);

	// Import fresh module for each test to reset module-scoped state
	// We need to re-import because index.ts has module-level globals (monitors map, etc.)
	vi.resetModules();
	const mod = await import("../index.js");
	mod.default(mockPi);

	// Fire session_start to initialize log dirs
	const sessionStartHandler = eventHandlers.get("session_start");
	if (sessionStartHandler) {
		await sessionStartHandler({}, mockCtx);
	}
});

afterEach(() => {
	// Fire session_shutdown to clean up timers/processes
	const shutdownHandler = eventHandlers.get("session_shutdown");
	if (shutdownHandler) {
		shutdownHandler({}, mockCtx).catch(() => {});
	}

	try {
		execSync(`rm -rf "${testDir}"`);
	} catch {
		/* best effort */
	}
});

// ─── Tool Registration ──────────────────────────────────────────────────────

describe("extension registration", () => {
	it("registers all four tools", () => {
		expect(tools.has("monitor_task")).toBe(true);
		expect(tools.has("list_monitors")).toBe(true);
		expect(tools.has("check_monitor")).toBe(true);
		expect(tools.has("cancel_monitor")).toBe(true);
	});

	it("registers message renderers", () => {
		expect(messageRenderers.has("task-monitor-heartbeat")).toBe(true);
		expect(messageRenderers.has("task-monitor-complete")).toBe(true);
	});

	it("registers session_start event handler", () => {
		expect(eventHandlers.has("session_start")).toBe(true);
	});

	it("creates .pi/monitors directory on session_start", () => {
		expect(existsSync(join(testDir, ".pi", "monitors"))).toBe(true);
	});
});

// ─── monitor_task (watch mode) ───────────────────────────────────────────────

describe("monitor_task — watch mode", () => {
	it("starts a watch monitor and returns confirmation", async () => {
		const result = await executeTool("monitor_task", {
			command: "echo hello && sleep 0.1",
			label: "test-watch",
			mode: "watch",
		});

		expect(result.content[0].text).toContain("Monitor 'test-watch' started");
		expect(result.content[0].text).toContain("Process spawned and running");
		expect(result.details.label).toBe("test-watch");
		expect(result.details.mode).toBe("watch");
		expect(result.details.logPath).toContain("test-watch");
	});

	it("creates a log file for the monitor", async () => {
		await executeTool("monitor_task", {
			command: "echo hi",
			label: "test-log",
			mode: "watch",
		});

		await waitForFinish("test-log");

		const logDir = join(testDir, ".pi", "monitors");
		const logs = readdirSync(logDir).filter((f) => f.startsWith("test-log") && f.endsWith(".log"));
		expect(logs.length).toBeGreaterThanOrEqual(1);
	});

	it("wakes agent with success on exit 0", async () => {
		await executeTool("monitor_task", {
			command: "echo done",
			label: "test-success",
			mode: "watch",
		});

		await waitForFinish("test-success");

		const completionCall = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === "test-success",
		);
		expect(completionCall).toBeTruthy();
		expect(completionCall[0].details.success).toBe(true);
		expect(completionCall[0].details.exitCode).toBe(0);
		expect(completionCall[1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	});

	it("wakes agent with failure on non-zero exit", async () => {
		await executeTool("monitor_task", {
			command: "exit 42",
			label: "test-fail",
			mode: "watch",
		});

		await waitForFinish("test-fail");

		const completionCall = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === "test-fail",
		);
		expect(completionCall).toBeTruthy();
		expect(completionCall[0].details.success).toBe(false);
		expect(completionCall[0].details.exitCode).toBe(42);
	});

	it("captures stdout in completion message", async () => {
		await executeTool("monitor_task", {
			command: 'echo "build output line"',
			label: "test-output",
			mode: "watch",
		});

		await waitForFinish("test-output");

		const completionCall = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === "test-output",
		);
		expect(completionCall[0].content).toContain("build output line");
	});

	it("rejects duplicate active labels", async () => {
		await executeTool("monitor_task", {
			command: "sleep 10",
			label: "dup-test",
			mode: "watch",
		});

		await expect(
			executeTool("monitor_task", {
				command: "echo hi",
				label: "dup-test",
				mode: "watch",
			}),
		).rejects.toThrow("already running");
	});

	it("sanitizes label characters", async () => {
		const result = await executeTool("monitor_task", {
			command: "echo hi",
			label: "my build@v2",
			mode: "watch",
		});

		expect(result.details.label).toBe("my_build_v2");
	});
});

// ─── monitor_task (poll mode) ────────────────────────────────────────────────

describe("monitor_task — poll mode", () => {
	it("starts a poll monitor and returns confirmation", async () => {
		const result = await executeTool("monitor_task", {
			command: "echo STATUS_READY",
			label: "test-poll",
			mode: "poll",
			pollInterval: 1,
			untilPatterns: ["STATUS_READY"],
		});

		expect(result.content[0].text).toContain("Polling every 1s");
		expect(result.content[0].text).toContain("Watching for: STATUS_READY");
	});

	it("completes on untilPattern match", async () => {
		await executeTool("monitor_task", {
			command: "echo DEPLOY_COMPLETE",
			label: "test-until",
			mode: "poll",
			pollInterval: 1,
			untilPatterns: ["DEPLOY_COMPLETE"],
		});

		await waitForFinish("test-until");

		const completionCall = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === "test-until",
		);
		expect(completionCall).toBeTruthy();
		expect(completionCall[0].details.success).toBe(true);
		expect(completionCall[0].details.reason).toContain("Matched completion pattern");
	});

	it("fails on failPattern match", async () => {
		await executeTool("monitor_task", {
			command: "echo ROLLBACK_FAILED",
			label: "test-failpat",
			mode: "poll",
			pollInterval: 1,
			untilPatterns: ["COMPLETE"],
			failPatterns: ["ROLLBACK_FAILED"],
		});

		await waitForFinish("test-failpat");

		const completionCall = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === "test-failpat",
		);
		expect(completionCall).toBeTruthy();
		expect(completionCall[0].details.success).toBe(false);
		expect(completionCall[0].details.reason).toContain("Matched failure pattern");
	});

	it("times out with maxDuration", async () => {
		await executeTool("monitor_task", {
			command: "echo still_waiting",
			label: "test-timeout",
			mode: "poll",
			pollInterval: 60, // won't poll again before timeout
			untilPatterns: ["NEVER_MATCH"],
			maxDuration: 1, // 1 second timeout
		});

		await waitForFinish("test-timeout");

		const completionCall = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === "test-timeout",
		);
		expect(completionCall).toBeTruthy();
		expect(completionCall[0].details.success).toBe(false);
		expect(completionCall[0].details.exitCode).toBe(124); // timeout exit code
	});
});

// ─── list_monitors ───────────────────────────────────────────────────────────

describe("list_monitors", () => {
	it("returns empty when no monitors", async () => {
		const result = await executeTool("list_monitors", {});
		expect(result.content[0].text).toContain("No active monitors");
		expect(result.details.monitors).toEqual([]);
	});

	it("lists running monitors", async () => {
		await executeTool("monitor_task", {
			command: "sleep 30",
			label: "long-running",
			mode: "watch",
		});

		const result = await executeTool("list_monitors", {});
		expect(result.content[0].text).toContain("long-running");
		expect(result.content[0].text).toContain("🔄 running");
		expect(result.details.monitors).toHaveLength(1);
		expect(result.details.monitors[0].label).toBe("long-running");
	});

	it("lists completed monitors", async () => {
		await executeTool("monitor_task", {
			command: "echo done",
			label: "quick",
			mode: "watch",
		});

		await waitForFinish("quick");

		const result = await executeTool("list_monitors", {});
		expect(result.content[0].text).toContain("quick");
		expect(result.content[0].text).toContain("✅ completed");
	});
});

// ─── check_monitor ───────────────────────────────────────────────────────────

describe("check_monitor", () => {
	it("throws for unknown label", async () => {
		await expect(executeTool("check_monitor", { label: "nope" })).rejects.toThrow("No monitor found");
	});

	it("returns running status with output", async () => {
		await executeTool("monitor_task", {
			command: "echo checking && sleep 30",
			label: "check-me",
			mode: "watch",
		});

		// Small delay for output to buffer
		await new Promise((r) => setTimeout(r, 200));

		const result = await executeTool("check_monitor", { label: "check-me" });
		expect(result.content[0].text).toContain("🔄 running");
		expect(result.content[0].text).toContain("check-me");
		expect(result.details.status).toBe("running");
	});

	it("returns completed status after finish", async () => {
		await executeTool("monitor_task", {
			command: "echo final-output",
			label: "check-done",
			mode: "watch",
		});

		await waitForFinish("check-done");

		const result = await executeTool("check_monitor", { label: "check-done" });
		expect(result.content[0].text).toContain("✅ completed");
		expect(result.details.status).toBe("completed");
		expect(result.details.exitCode).toBe(0);
	});

	it("returns failed status", async () => {
		await executeTool("monitor_task", {
			command: "exit 1",
			label: "check-fail",
			mode: "watch",
		});

		await waitForFinish("check-fail");

		const result = await executeTool("check_monitor", { label: "check-fail" });
		expect(result.content[0].text).toContain("❌ failed");
		expect(result.details.status).toBe("failed");
	});

	it("respects tailLines parameter", async () => {
		await executeTool("monitor_task", {
			command: 'for i in $(seq 1 20); do echo "line $i"; done',
			label: "check-tail",
			mode: "watch",
		});

		await waitForFinish("check-tail");

		const result = await executeTool("check_monitor", { label: "check-tail", tailLines: 3 });
		const outputBlock = result.content[0].text;
		// Should contain last few lines, not all 20
		expect(outputBlock).toContain("line 20");
	});
});

// ─── cancel_monitor ──────────────────────────────────────────────────────────

describe("cancel_monitor", () => {
	it("throws for unknown label", async () => {
		await expect(executeTool("cancel_monitor", { label: "nope" })).rejects.toThrow("No monitor found");
	});

	it("cancels a running monitor", async () => {
		await executeTool("monitor_task", {
			command: "sleep 60",
			label: "cancel-me",
			mode: "watch",
		});

		const result = await executeTool("cancel_monitor", { label: "cancel-me" });
		expect(result.content[0].text).toContain("cancelled");
		expect(result.details.cancelled).toBe(true);

		// Should have sent completion with exit 130
		await waitForFinish("cancel-me");
		const completionCall = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === "cancel-me",
		);
		expect(completionCall[0].details.exitCode).toBe(130);
	});

	it("returns already-finished for completed monitors", async () => {
		await executeTool("monitor_task", {
			command: "echo done",
			label: "already-done",
			mode: "watch",
		});

		await waitForFinish("already-done");

		const result = await executeTool("cancel_monitor", { label: "already-done" });
		expect(result.content[0].text).toContain("already finished");
		expect(result.details.alreadyFinished).toBe(true);
	});

	it("cancels a poll monitor", async () => {
		await executeTool("monitor_task", {
			command: "echo waiting",
			label: "cancel-poll",
			mode: "poll",
			pollInterval: 60,
			untilPatterns: ["NEVER"],
		});

		// Small delay for first poll
		await new Promise((r) => setTimeout(r, 200));

		const result = await executeTool("cancel_monitor", { label: "cancel-poll" });
		expect(result.details.cancelled).toBe(true);
	});
});

// ─── Heartbeats ──────────────────────────────────────────────────────────────

describe("heartbeats", () => {
	it("sends FYI heartbeats at configured interval", async () => {
		await executeTool("monitor_task", {
			command: "sleep 5",
			label: "hb-test",
			mode: "watch",
			heartbeat: 1, // 1 second
		});

		// Wait for at least one heartbeat
		await new Promise((r) => setTimeout(r, 1500));

		const hbCalls = mockPi.sendMessage.mock.calls.filter(
			(c: any) => c[0]?.customType === "task-monitor-heartbeat" && c[0]?.details?.label === "hb-test",
		);
		expect(hbCalls.length).toBeGreaterThanOrEqual(1);
		expect(hbCalls[0][1].triggerTurn).toBe(false);
		expect(hbCalls[0][1].deliverAs).toBe("nextTurn");
	});

	it("sends triggering heartbeats when heartbeatTrigger is true", async () => {
		await executeTool("monitor_task", {
			command: "sleep 5",
			label: "hb-trigger",
			mode: "watch",
			heartbeat: 1,
			heartbeatTrigger: true,
		});

		await new Promise((r) => setTimeout(r, 1500));

		const hbCalls = mockPi.sendMessage.mock.calls.filter(
			(c: any) => c[0]?.customType === "task-monitor-heartbeat" && c[0]?.details?.label === "hb-trigger",
		);
		expect(hbCalls.length).toBeGreaterThanOrEqual(1);
		expect(hbCalls[0][1].triggerTurn).toBe(true);
		expect(hbCalls[0][1].deliverAs).toBe("followUp");
	});
});

// ─── Stderr capture ──────────────────────────────────────────────────────────

describe("stderr capture", () => {
	it("captures stderr output in buffer", async () => {
		await executeTool("monitor_task", {
			command: "echo error-output >&2",
			label: "stderr-test",
			mode: "watch",
		});

		await waitForFinish("stderr-test");

		const result = await executeTool("check_monitor", { label: "stderr-test" });
		expect(result.content[0].text).toContain("error-output");
	});
});

// ─── Session lifecycle ───────────────────────────────────────────────────────

describe("session lifecycle", () => {
	it("cleans up old logs on session_start (notification)", async () => {
		// Create an old log file
		const logDir = join(testDir, ".pi", "monitors");
		mkdirSync(logDir, { recursive: true });
		const oldLog = join(logDir, "old-test-2020.log");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(oldLog, "old");
		execSync(`touch -t 202001010000.00 "${oldLog}"`);

		// Re-trigger session_start
		vi.resetModules();
		const mod2 = await import("../index.js");
		const pi2 = createMockPi();
		const ctx2 = createMockCtx(testDir);
		mod2.default(pi2);
		const handler = eventHandlers.get("session_start")!;
		await handler({}, ctx2);

		expect(ctx2.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cleaned"), "info");
	});

	it("detects orphans and prompts user", async () => {
		// Create a PID file with dead parent
		const pidDir = join(testDir, ".pi", "monitors", ".pids");
		mkdirSync(pidDir, { recursive: true });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(pidDir, "orphan.json"),
			JSON.stringify({ label: "orphan", parentPid: 99999999, childPid: null, startedAt: Date.now() }),
		);

		vi.resetModules();
		const mod2 = await import("../index.js");
		const pi2 = createMockPi();
		const ctx2 = createMockCtx(testDir);
		ctx2.ui.confirm = vi.fn().mockResolvedValue(false);
		mod2.default(pi2);

		const handler = eventHandlers.get("session_start")!;
		await handler({}, ctx2);

		expect(ctx2.ui.confirm).toHaveBeenCalledWith(
			expect.stringContaining("orphaned"),
			expect.stringContaining("orphan"),
		);
		// User declined — should notify and clean up PID files anyway
		expect(ctx2.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Left"), "warning");
	});

	it("kills orphans when user confirms", async () => {
		const pidDir = join(testDir, ".pi", "monitors", ".pids");
		mkdirSync(pidDir, { recursive: true });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(pidDir, "orphan2.json"),
			JSON.stringify({ label: "orphan2", parentPid: 99999999, childPid: null, startedAt: Date.now() }),
		);

		vi.resetModules();
		const mod2 = await import("../index.js");
		const pi2 = createMockPi();
		const ctx2 = createMockCtx(testDir);
		ctx2.ui.confirm = vi.fn().mockResolvedValue(true); // User says yes
		mod2.default(pi2);

		const handler = eventHandlers.get("session_start")!;
		await handler({}, ctx2);

		expect(ctx2.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Killed"), "info");
		// PID file should be cleaned up
		expect(existsSync(join(pidDir, "orphan2.json"))).toBe(false);
	});

	it("session_shutdown kills active monitors", async () => {
		await executeTool("monitor_task", {
			command: "sleep 60",
			label: "shutdown-test",
			mode: "watch",
		});

		// Fire shutdown
		const shutdownHandler = eventHandlers.get("session_shutdown")!;
		await shutdownHandler({}, mockCtx);

		// After shutdown, the monitor should be marked finished
		const result = await executeTool("check_monitor", { label: "shutdown-test" });
		// It was force-finished by shutdown
		expect(result.details.status).not.toBe("running");
	});
});

// ─── Self-healing retries ────────────────────────────────────────────────────

describe("self-healing retries (watch mode)", () => {
	it("retries on failure and eventually succeeds", async () => {
		// Command that fails first time, succeeds second (uses a temp file as state)
		const stateFile = join(testDir, "retry-state");
		const cmd = `if [ -f "${stateFile}" ]; then echo success; exit 0; else touch "${stateFile}"; echo fail; exit 1; fi`;

		await executeTool("monitor_task", {
			command: cmd,
			label: "retry-test",
			mode: "watch",
			maxRetries: 3,
			retryBackoffMs: 100, // fast for testing
			retryMaxBackoffMs: 200,
		});

		await waitForFinish("retry-test", 10000);

		const completionCall = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === "retry-test",
		);
		expect(completionCall).toBeTruthy();
		expect(completionCall[0].details.success).toBe(true);
		expect(completionCall[0].details.retryCount).toBe(1);
	});

	it("sends retry notification as FYI message", async () => {
		const stateFile = join(testDir, "retry-notif-state");
		const cmd = `if [ -f "${stateFile}" ]; then echo ok; exit 0; else touch "${stateFile}"; exit 1; fi`;

		await executeTool("monitor_task", {
			command: cmd,
			label: "retry-notif",
			mode: "watch",
			maxRetries: 2,
			retryBackoffMs: 100,
		});

		await waitForFinish("retry-notif", 10000);

		// Should have a heartbeat-type message about the retry
		const retryNotif = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-heartbeat" && c[0]?.content?.includes("retrying"),
		);
		expect(retryNotif).toBeTruthy();
		expect(retryNotif[1].triggerTurn).toBe(false); // FYI, not triggering
	});

	it("gives up after max retries", async () => {
		await executeTool("monitor_task", {
			command: "exit 1",
			label: "retry-exhaust",
			mode: "watch",
			maxRetries: 2,
			retryBackoffMs: 50,
			retryMaxBackoffMs: 100,
		});

		await waitForFinish("retry-exhaust", 10000);

		const completionCall = mockPi.sendMessage.mock.calls.find(
			(c: any) => c[0]?.customType === "task-monitor-complete" && c[0]?.details?.label === "retry-exhaust",
		);
		expect(completionCall).toBeTruthy();
		expect(completionCall[0].details.success).toBe(false);
		expect(completionCall[0].details.retryCount).toBe(2);
	});
});

// ─── Message Renderers ───────────────────────────────────────────────────────

describe("message renderers", () => {
	const mockTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	it("renders heartbeat message", () => {
		const renderer = messageRenderers.get("task-monitor-heartbeat")!;
		const result = renderer({ content: "🔄 build — running 5s" }, {}, mockTheme);
		expect(result.text).toContain("build");
	});

	it("renders success completion message", () => {
		const renderer = messageRenderers.get("task-monitor-complete")!;
		const result = renderer(
			{
				content: "Build completed",
				details: { success: true, label: "build", elapsed: "5s" },
			},
			{ expanded: false },
			mockTheme,
		);
		expect(result.text).toContain("✅");
		expect(result.text).toContain("build");
	});

	it("renders failure completion message", () => {
		const renderer = messageRenderers.get("task-monitor-complete")!;
		const result = renderer(
			{
				content: "Build failed",
				details: { success: false, label: "build", elapsed: "3s" },
			},
			{ expanded: false },
			mockTheme,
		);
		expect(result.text).toContain("❌");
	});

	it("includes full content when expanded", () => {
		const renderer = messageRenderers.get("task-monitor-complete")!;
		const result = renderer(
			{
				content: "Full build output here",
				details: { success: true, label: "build", elapsed: "5s" },
			},
			{ expanded: true },
			mockTheme,
		);
		expect(result.text).toContain("Full build output here");
	});

	it("handles missing details gracefully", () => {
		const renderer = messageRenderers.get("task-monitor-complete")!;
		const result = renderer({ content: "test", details: undefined }, { expanded: false }, mockTheme);
		expect(result.text).toContain("unknown");
	});
});

// ─── renderCall / renderResult ───────────────────────────────────────────────

describe("tool renderers", () => {
	const mockTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	it("renderCall shows mode and label", () => {
		const tool = tools.get("monitor_task");
		const result = tool.renderCall({ mode: "watch", label: "build", command: "make" }, mockTheme);
		expect(result.text).toContain("watch");
		expect(result.text).toContain("build");
		expect(result.text).toContain("make");
	});

	it("renderResult shows label and log path", () => {
		const tool = tools.get("monitor_task");
		const result = tool.renderResult(
			{ details: { label: "build", mode: "watch", logPath: "/tmp/build.log" } },
			{},
			mockTheme,
		);
		expect(result.text).toContain("build");
		expect(result.text).toContain("/tmp/build.log");
	});

	it("renderResult handles missing details", () => {
		const tool = tools.get("monitor_task");
		const result = tool.renderResult({ content: [{ text: "fallback text" }] }, {}, mockTheme);
		expect(result.text).toContain("fallback text");
	});
});
