import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	bufferOutput,
	buildCompletionMessage,
	buildHeartbeatStatus,
	buildWidgetLines,
	calculateBackoff,
	cleanupOldLogs as cleanupOldLogsUtil,
	createLogPath as createLogPathUtil,
	findOrphans,
	formatDuration,
	formatListEntry,
	getTail,
	matchesAnyPattern,
	removePidFile as removePidFileUtil,
	sanitizeLabel,
	shouldRetry as shouldRetryUtil,
	writePidFile as writePidFileUtil,
} from "./utils.js";

// ─── TODO: Tmux Pane Support ─────────────────────────────────────────────────
// Add optional `pane: true | "split-h" | "split-v" | "window"` to monitor_task
// that spawns the process in a visible tmux pane instead of invisibly via child_process.
// - User can visually watch live output scroll in a real terminal pane
// - Can Ctrl+C a stuck process directly in the pane
// - Each monitor gets its own pane, like a mini-dashboard
// - Capture output via `tmux capture-pane` for the wakeup message
// - On exit, pane auto-closes or shows exit status
// - Implementation: `tmux split-window -h 'bash -c "command 2>&1 | tee logfile"'`
//   then poll pane for exit status. ~50 lines on top of existing code.
// - Could borrow amux's (github.com/mixpeek/amux) pattern of status detection
//   via tmux output parsing — no hooks needed.
// - v3: local REST API for multi-session monitor sharing, web dashboard.
// ─────────────────────────────────────────────────────────────────────────────

// ─── TODO: Tool-Based Polling ────────────────────────────────────────────────
// Currently poll mode only runs shell commands via `bash -c`. Extend to support
// calling any registered pi tool as the poll action. This would enable:
//
// - `fetch_content` polling: check a URL for status changes
//     monitor_task({ poll: { tool: "fetch_content", args: { url: "https://ci.example.com/job/123/api/json" } } })
//
// - `read` polling: watch a file for changes
//     monitor_task({ poll: { tool: "read", args: { path: "/tmp/training/status.txt" } } })
//
// - `mcp` polling: query an MCP server for status
//     monitor_task({ poll: { tool: "mcp", args: { tool: "github_get_run", args: '{"run_id": "123"}' } } })
//
// - `bash` polling (current behavior, but explicit):
//     monitor_task({ poll: { tool: "bash", args: { command: "kubectl get pods" } } })
//
// Implementation:
// - Add `pollTool` and `pollArgs` parameters (alternative to `command` in poll mode)
// - Use pi.exec() or invoke the tool directly via the extension API
// - Pattern matching works the same way on the tool's text output
// - The tool's structured result could be passed to an LLM for agent-mode analysis (v2)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Guardrails Note ─────────────────────────────────────────────────────────
// Commands are checked by pi-guardrails extension via tool_call event hook.
// Guardrails inspects event.input.command on monitor_task (same as bash).
// No duplicate pattern matching needed here — guardrails is the single
// enforcement point for dangerous command blocking.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Monitor Types ───────────────────────────────────────────────────────────
// Keep in sync with utils.ts MonitorEntry.
// `process` is typed as ChildProcess here (vs `any` in utils.ts to avoid
// importing child_process into the pure utils module).

interface MonitorEntry {
	label: string;
	command: string;
	cwd: string;
	mode: "watch" | "poll";
	startTime: number;
	process: ChildProcess | null;
	logPath: string;
	outputBuffer: string[];
	maxBufferLines: number;
	tailLines: number;
	heartbeatInterval: number | null;
	heartbeatTrigger: boolean;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	// Poll-mode fields
	pollInterval?: number;
	pollTimer?: ReturnType<typeof setInterval> | null;
	pollCount?: number;
	lastPollOutput?: string;
	activePollProc?: ChildProcess | null;
	untilPatterns?: string[];
	failPatterns?: string[];
	maxDuration?: number;
	maxDurationTimer?: ReturnType<typeof setTimeout> | null;
	// Retry / self-healing fields
	maxRetries: number;
	retryCount: number;
	retryBackoffMs: number;
	retryMaxBackoffMs: number;
	// State
	exitCode: number | null;
	finished: boolean;
	error?: string;
}

// ─── Globals ─────────────────────────────────────────────────────────────────

const monitors = new Map<string, MonitorEntry>();
let piApi: ExtensionAPI;
let savedTitle: string | undefined;
let completionTitleTimer: ReturnType<typeof setTimeout> | null = null;
let projectLogDir: string; // set on session_start from ctx.cwd
const PID = process.pid;
const LOG_CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Log Directory (project-local) ──────────────────────────────────────────

function getLogDir(cwd?: string): string {
	if (projectLogDir) return projectLogDir;
	const base = cwd ?? process.cwd();
	return join(base, ".pi", "monitors");
}

function ensureLogDir(cwd?: string) {
	mkdirSync(getLogDir(cwd), { recursive: true });
}

function initLogDir(cwd: string) {
	projectLogDir = join(cwd, ".pi", "monitors");
	ensureLogDir(cwd);
	ensurePidDir();
}

// ─── PID / Log Wrappers (delegate to utils with module-scoped dirs) ─────────

function getPidDir(): string {
	return join(getLogDir(), ".pids");
}

function ensurePidDir() {
	mkdirSync(getPidDir(), { recursive: true });
}

function writePidFile(label: string, childPid: number | undefined) {
	writePidFileUtil(getPidDir(), label, PID, childPid);
}

function removePidFile(label: string) {
	removePidFileUtil(getPidDir(), label);
}

function checkForOrphans() {
	return findOrphans(getPidDir());
}

function cleanupOldLogs(): number {
	return cleanupOldLogsUtil(getLogDir(), LOG_CLEANUP_MAX_AGE_MS);
}

function createLogPath(label: string): string {
	ensureLogDir();
	return createLogPathUtil(getLogDir(), label);
}

// ─── Tmux Title ──────────────────────────────────────────────────────────────

function updateTmuxTitle() {
	const active = [...monitors.values()].filter((m) => !m.finished);
	if (active.length === 0) {
		if (savedTitle) {
			process.stdout.write(`\x1b]0;${savedTitle}\x07`);
		} else {
			process.stdout.write(`\x1b]0;pi\x07`);
		}
		return;
	}
	const parts = active.map((m) => {
		const elapsed = formatDuration(Date.now() - m.startTime);
		const modeIcon = m.mode === "poll" ? `⟳${m.pollCount ?? 0}` : "";
		return `🔄 ${m.label} ${elapsed}${modeIcon ? ` ${modeIcon}` : ""}`;
	});
	process.stdout.write(`\x1b]0;${parts.join(" | ")}\x07`);
}

function setCompletionTitle(label: string, success: boolean) {
	const emoji = success ? "✅" : "❌";
	process.stdout.write(`\x1b]0;${emoji} ${label} — pi\x07`);
	if (completionTitleTimer) clearTimeout(completionTitleTimer);
	completionTitleTimer = setTimeout(() => {
		completionTitleTimer = null;
		updateTmuxTitle();
	}, 5000);
}

// ─── Log I/O ─────────────────────────────────────────────────────────────────
// NOTE: appendFileSync is intentional — simple and correct for typical build
// output volume. For high-throughput processes (e.g., streaming MB/s), consider
// replacing with fs.createWriteStream.

function appendToLog(entry: MonitorEntry, data: string) {
	try {
		appendFileSync(entry.logPath, data);
	} catch {
		// Ignore write errors
	}
}

// ─── Watch Mode ──────────────────────────────────────────────────────────────

function startWatch(entry: MonitorEntry) {
	const proc = spawn("bash", ["-c", entry.command], {
		cwd: entry.cwd,
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	});

	entry.process = proc;

	writePidFile(entry.label, proc.pid);

	const header = `=== Task Monitor: ${entry.label} ===\nCommand: ${entry.command}\nCwd: ${entry.cwd}\nStarted: ${new Date().toISOString()}\n${"=".repeat(50)}\n\n`;
	appendToLog(entry, header);

	proc.stdout?.on("data", (data: Buffer) => {
		const str = data.toString();
		appendToLog(entry, str);
		bufferOutput(entry, str);
		updateTmuxTitle();
	});

	proc.stderr?.on("data", (data: Buffer) => {
		const str = data.toString();
		appendToLog(entry, `[stderr] ${str}`);
		bufferOutput(entry, str);
	});

	proc.on("error", (err) => {
		entry.error = err.message;
		finishMonitor(entry, null);
	});

	proc.on("exit", (code, signal) => {
		const exitCode = code ?? (signal ? 128 : 1);
		finishMonitor(entry, exitCode);
	});

	startHeartbeat(entry);
	updateTmuxTitle();
}

// ─── Poll Mode ───────────────────────────────────────────────────────────────

function startPoll(entry: MonitorEntry) {
	entry.pollCount = 0;

	const header = `=== Task Monitor (poll): ${entry.label} ===\nCommand: ${entry.command}\nCwd: ${entry.cwd}\nInterval: ${entry.pollInterval}s\nStarted: ${new Date().toISOString()}\nUntil patterns: ${(entry.untilPatterns ?? []).join(", ")}\nFail patterns: ${(entry.failPatterns ?? []).join(", ")}\n${"=".repeat(50)}\n\n`;
	appendToLog(entry, header);

	runPoll(entry);

	entry.pollTimer = setInterval(
		() => {
			if (!entry.finished) {
				runPoll(entry);
			}
		},
		(entry.pollInterval ?? 30) * 1000,
	);

	// Max duration timeout — use != null so maxDuration=0 is not silently ignored
	if (entry.maxDuration != null) {
		entry.maxDurationTimer = setTimeout(() => {
			if (!entry.finished) {
				entry.error = `Timed out after ${entry.maxDuration}s`;
				finishMonitor(entry, 124); // timeout exit code
			}
		}, entry.maxDuration * 1000);
	}

	startHeartbeat(entry);
	updateTmuxTitle();
}

function runPoll(entry: MonitorEntry) {
	entry.pollCount = (entry.pollCount ?? 0) + 1;
	const pollNum = entry.pollCount;

	const proc = spawn("bash", ["-c", entry.command], {
		cwd: entry.cwd,
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Track active poll process so it can be killed on cancel
	entry.activePollProc = proc;

	let stdout = "";
	let stderr = "";

	proc.stdout?.on("data", (data: Buffer) => {
		stdout += data.toString();
	});
	proc.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});

	proc.on("exit", (code) => {
		if (entry.activePollProc === proc) {
			entry.activePollProc = null;
		}
		if (entry.finished) return;

		const output = (stdout + stderr).trim();
		entry.lastPollOutput = output;

		const logEntry = `\n--- Poll #${pollNum} (${new Date().toISOString()}) exit=${code} ---\n${output}\n`;
		appendToLog(entry, logEntry);
		bufferOutput(entry, `[poll #${pollNum}] ${output}`);

		updateTmuxTitle();

		// Check completion patterns
		if (entry.untilPatterns?.length) {
			const match = matchesAnyPattern(output, entry.untilPatterns);
			if (match) {
				finishMonitor(entry, 0, `Matched completion pattern: ${match}`);
				return;
			}
		}

		// Check failure patterns
		if (entry.failPatterns?.length) {
			const match = matchesAnyPattern(output, entry.failPatterns);
			if (match) {
				finishMonitor(entry, 1, `Matched failure pattern: ${match}`);
				return;
			}
		}

		// Non-zero exit in poll mode is not auto-failure — the command might
		// legitimately return non-zero while in progress. Just log it.
		if (code !== 0 && code !== null) {
			bufferOutput(entry, `[poll #${pollNum} exited with code ${code}]`);
		}
	});

	proc.on("error", (err) => {
		if (!entry.finished) {
			bufferOutput(entry, `[poll #${pollNum} error: ${err.message}]`);
		}
	});
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

function startHeartbeat(entry: MonitorEntry) {
	if (!entry.heartbeatInterval) return;

	entry.heartbeatTimer = setInterval(() => {
		if (entry.finished) return;

		const status = buildHeartbeatStatus(entry);

		// When heartbeatTrigger is true, the agent takes a turn on each heartbeat.
		// Use this for relaying status to remote channels (Slack, Discord, etc).
		// When false (default), heartbeats are queued for nextTurn — visible to user
		// but don't interrupt the agent's current work.
		if (entry.heartbeatTrigger) {
			piApi.sendMessage(
				{
					customType: "task-monitor-heartbeat",
					content: status,
					display: true,
					details: {
						label: entry.label,
						mode: entry.mode,
						elapsed: Date.now() - entry.startTime,
						lines: entry.outputBuffer.length,
						pollCount: entry.pollCount,
						retryCount: entry.retryCount,
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else {
			piApi.sendMessage(
				{
					customType: "task-monitor-heartbeat",
					content: status,
					display: true,
					details: {
						label: entry.label,
						mode: entry.mode,
						elapsed: Date.now() - entry.startTime,
						lines: entry.outputBuffer.length,
						pollCount: entry.pollCount,
						retryCount: entry.retryCount,
					},
				},
				{ triggerTurn: false, deliverAs: "nextTurn" },
			);
		}
	}, entry.heartbeatInterval * 1000);
}

// ─── Completion ──────────────────────────────────────────────────────────────

function finishMonitor(entry: MonitorEntry, exitCode: number | null, reason?: string) {
	if (entry.finished) return;

	// ─── Self-healing: retry on failure for watch mode ────────────────────
	const wasCancelled = reason === "Cancelled by user";
	const shouldRetry = !wasCancelled && shouldRetryUtil(entry, exitCode, reason);

	if (shouldRetry) {
		entry.retryCount++;
		const backoff = calculateBackoff(entry.retryCount, entry.retryBackoffMs, entry.retryMaxBackoffMs);

		const retryMsg = `⟳ ${entry.label} — failed (exit ${exitCode}), retrying in ${formatDuration(backoff)} (attempt ${entry.retryCount}/${entry.maxRetries})`;
		appendToLog(
			entry,
			`\n--- RETRY ${entry.retryCount}/${entry.maxRetries} after ${backoff}ms (exit ${exitCode}) ---\n`,
		);
		bufferOutput(entry, `[retry ${entry.retryCount}/${entry.maxRetries} in ${formatDuration(backoff)}]`);

		piApi.sendMessage(
			{
				customType: "task-monitor-heartbeat",
				content: retryMsg,
				display: true,
				details: {
					label: entry.label,
					mode: entry.mode,
					retryCount: entry.retryCount,
					maxRetries: entry.maxRetries,
					backoffMs: backoff,
				},
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);

		// Clean up old process (but NOT heartbeat — keep it running)
		if (entry.process && !entry.process.killed) {
			try {
				entry.process.kill("SIGTERM");
			} catch {
				/* */
			}
		}
		entry.process = null;

		setTimeout(() => {
			if (!entry.finished) {
				startWatch(entry);
				updateTmuxTitle();
			}
		}, backoff);

		return;
	}

	// ─── Normal completion ───────────────────────────────────────────────
	entry.finished = true;
	entry.exitCode = exitCode;

	removePidFile(entry.label);

	// Clean up timers
	if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
	if (entry.pollTimer) clearInterval(entry.pollTimer);
	if (entry.maxDurationTimer) clearTimeout(entry.maxDurationTimer);

	// Kill processes if still running
	if (entry.process && !entry.process.killed) {
		try {
			entry.process.kill("SIGTERM");
		} catch {
			/* already dead */
		}
	}
	if (entry.activePollProc && !entry.activePollProc.killed) {
		try {
			entry.activePollProc.kill("SIGTERM");
		} catch {
			/* already dead */
		}
	}

	// Write footer to log
	const retryInfo = entry.retryCount > 0 ? `Retries: ${entry.retryCount}/${entry.maxRetries}\n` : "";
	const footer = `\n${"=".repeat(50)}\nFinished: ${new Date().toISOString()}\nExit code: ${exitCode}\nDuration: ${formatDuration(Date.now() - entry.startTime)}\n${retryInfo}${reason ? `Reason: ${reason}\n` : ""}${entry.error ? `Error: ${entry.error}\n` : ""}`;
	appendToLog(entry, footer);

	const success = exitCode === 0;

	setCompletionTitle(entry.label, success);

	const content = buildCompletionMessage(entry, exitCode, reason);

	// Wake the agent with triggerTurn. Use deliverAs "followUp" so completion
	// messages don't interrupt the agent's current tool calls.
	piApi.sendMessage(
		{
			customType: "task-monitor-complete",
			content,
			display: true,
			details: {
				label: entry.label,
				command: entry.command,
				mode: entry.mode,
				exitCode,
				success,
				elapsed: formatDuration(Date.now() - entry.startTime),
				reason,
				error: entry.error,
				logPath: entry.logPath,
				pollCount: entry.pollCount,
				retryCount: entry.retryCount,
				maxRetries: entry.maxRetries,
				outputLines: entry.outputBuffer.length,
			},
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);

	// Clean up from map after a delay (keep for status queries)
	setTimeout(() => {
		monitors.delete(entry.label);
	}, 60_000);
}

// ─── Widget ──────────────────────────────────────────────────────────────────

function updateWidget(ctx: { ui: { setWidget: (id: string, content: any, options?: any) => void } }) {
	const lines = buildWidgetLines([...monitors.values()]);
	if (!lines) {
		ctx.ui.setWidget("task-monitor", undefined);
		return;
	}
	ctx.ui.setWidget("task-monitor", lines, { placement: "belowEditor" });
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	piApi = pi;

	pi.on("session_start", async (_event, ctx) => {
		savedTitle = undefined;

		initLogDir(ctx.cwd);

		const cleaned = cleanupOldLogs();
		if (cleaned > 0) {
			ctx.ui.notify(`🗑️ Cleaned ${cleaned} old monitor log(s)`, "info");
		}

		const orphans = checkForOrphans();
		if (orphans.length > 0) {
			const orphanList = orphans.map(
				(o) => `${o.label} (child PID: ${o.childPid ?? "unknown"}, started: ${new Date(o.startedAt).toLocaleString()})`,
			);
			const killThem = await ctx.ui.confirm(
				`⚠️ Found ${orphans.length} orphaned monitor(s)`,
				`These monitors were left running by a crashed pi session:\n\n${orphanList.map((o) => `  • ${o}`).join("\n")}\n\nKill them?`,
			);
			if (killThem) {
				for (const orphan of orphans) {
					if (orphan.childPid) {
						try {
							process.kill(orphan.childPid, "SIGTERM");
						} catch {
							/* already dead */
						}
					}
					removePidFile(orphan.label);
				}
				ctx.ui.notify(`Killed ${orphans.length} orphaned monitor(s)`, "info");
			} else {
				ctx.ui.notify(`Left ${orphans.length} orphaned monitor(s) running`, "warning");
				for (const orphan of orphans) {
					removePidFile(orphan.label);
				}
			}
		}

		const widgetInterval = setInterval(() => {
			if (monitors.size > 0) updateWidget(ctx);
		}, 5000);

		pi.on("session_shutdown", async () => {
			clearInterval(widgetInterval);
			for (const entry of monitors.values()) {
				if (!entry.finished) {
					entry.finished = true;
					if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
					if (entry.pollTimer) clearInterval(entry.pollTimer);
					if (entry.maxDurationTimer) clearTimeout(entry.maxDurationTimer);
					if (entry.process && !entry.process.killed) {
						try {
							entry.process.kill("SIGTERM");
						} catch {
							/* */
						}
					}
					if (entry.activePollProc && !entry.activePollProc.killed) {
						try {
							entry.activePollProc.kill("SIGTERM");
						} catch {
							/* */
						}
					}
					removePidFile(entry.label);
				}
			}
		});
	});

	// ─── monitor_task tool ────────────────────────────────────────────────

	pi.registerTool({
		name: "monitor_task",
		label: "Monitor Task",
		description:
			"Kick off a background shell process and monitor it until completion. " +
			"The agent is freed immediately and will be woken up with full output context when the process finishes. " +
			"Use mode 'watch' for long-running processes (builds, tests, training jobs). " +
			"Use mode 'poll' to run a command repeatedly and detect completion via pattern matching (CloudFormation, Terraform, CI pipelines).",
		promptSnippet: "Run a background process and get woken up when it completes with output for analysis",
		promptGuidelines: [
			"Use monitor_task for any long-running shell command (builds, tests, deployments, training jobs) instead of bash when the process will take more than ~30 seconds.",
			"After calling monitor_task, tell the user the process is being monitored and you'll report back when it completes.",
			"In poll mode, set untilPatterns to match completion states and failPatterns to match failure states.",
			"Use heartbeat (in seconds) for periodic status updates visible to the user.",
			"Use maxRetries for flaky processes that may need self-healing restarts with exponential backoff (watch mode only).",
			"Use heartbeatTrigger: true when you need to relay periodic status to a remote channel (e.g., Slack, Discord).",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to execute" }),
			label: Type.String({
				description:
					"Short label for this monitor (e.g., 'tests', 'build', 'cfn-deploy'). Must be unique among active monitors.",
			}),
			mode: StringEnum(["watch", "poll"] as const, {
				description: "watch: run once, monitor until exit. poll: run repeatedly on interval, match patterns.",
			}),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
			tailLines: Type.Optional(
				Type.Number({ description: "Lines of output tail to include in wake-up message (default: 100)" }),
			),
			heartbeat: Type.Optional(
				Type.Number({ description: "Heartbeat interval in seconds. Sends periodic FYI status (default: none)" }),
			),
			heartbeatTrigger: Type.Optional(
				Type.Boolean({
					description:
						"If true, heartbeats wake the agent (triggerTurn) so it can relay status to remote channels. Default: false (heartbeats are FYI only).",
				}),
			),
			maxRetries: Type.Optional(
				Type.Number({
					description:
						"Max retry attempts on failure (watch mode only). Process restarts with exponential backoff. Default: 0 (no retries).",
				}),
			),
			retryBackoffMs: Type.Optional(
				Type.Number({
					description:
						"Initial backoff in ms before first retry (default: 2000). Doubles each retry up to retryMaxBackoffMs.",
				}),
			),
			retryMaxBackoffMs: Type.Optional(
				Type.Number({
					description: "Maximum backoff in ms between retries (default: 60000).",
				}),
			),
			pollInterval: Type.Optional(
				Type.Number({ description: "Poll interval in seconds (default: 30). Only for poll mode." }),
			),
			untilPatterns: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Completion patterns — monitor finishes successfully when output contains any of these (poll mode)",
				}),
			),
			failPatterns: Type.Optional(
				Type.Array(Type.String(), {
					description: "Failure patterns — monitor finishes with failure when output contains any of these (poll mode)",
				}),
			),
			maxDuration: Type.Optional(
				Type.Number({ description: "Maximum duration in seconds before timeout (poll mode). Default: none." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const label = sanitizeLabel(params.label);

			// Check for duplicate
			if (monitors.has(label) && !monitors.get(label)!.finished) {
				throw new Error(`Monitor '${label}' is already running. Use cancel_monitor to stop it first.`);
			}

			const entry: MonitorEntry = {
				label,
				command: params.command,
				cwd: params.cwd ?? ctx.cwd,
				mode: params.mode,
				startTime: Date.now(),
				process: null,
				logPath: createLogPath(label),
				outputBuffer: [],
				maxBufferLines: 5000,
				tailLines: params.tailLines ?? 100,
				heartbeatInterval: params.heartbeat ?? null,
				heartbeatTrigger: params.heartbeatTrigger ?? false,
				heartbeatTimer: null,
				pollInterval: params.pollInterval ?? 30,
				pollTimer: null,
				pollCount: 0,
				lastPollOutput: undefined,
				activePollProc: null,
				untilPatterns: params.untilPatterns,
				failPatterns: params.failPatterns,
				maxDuration: params.maxDuration,
				maxDurationTimer: null,
				maxRetries: params.maxRetries ?? 0,
				retryCount: 0,
				retryBackoffMs: params.retryBackoffMs ?? 2000,
				retryMaxBackoffMs: params.retryMaxBackoffMs ?? 60000,
				exitCode: null,
				finished: false,
			};

			monitors.set(label, entry);

			if (monitors.size === 1) {
				savedTitle = undefined;
			}

			if (params.mode === "watch") {
				startWatch(entry);
			} else {
				startPoll(entry);
			}

			updateWidget(ctx);
			updateTmuxTitle();

			const modeDesc =
				params.mode === "watch"
					? "Process spawned and running."
					: `Polling every ${entry.pollInterval}s.${entry.untilPatterns?.length ? ` Watching for: ${entry.untilPatterns.join(", ")}` : ""}`;

			return {
				content: [
					{
						type: "text" as const,
						text: `🔄 Monitor '${label}' started. ${modeDesc}\nLog: ${entry.logPath}\nYou will be notified when the process completes.`,
					},
				],
				details: {
					label,
					mode: params.mode,
					logPath: entry.logPath,
					command: params.command,
				},
			};
		},

		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("monitor_task "));
			text += theme.fg("accent", args.mode ?? "watch");
			text += ` ${theme.fg("muted", args.label ?? "")}`;
			text += `\n  ${theme.fg("dim", args.command ?? "")}`;
			return new Text(text, 0, 0);
		},

		renderResult(result: any, _options: any, theme: any) {
			const details = result.details;
			if (!details) {
				return new Text(theme.fg("dim", result.content?.[0]?.text ?? ""), 0, 0);
			}
			let text = theme.fg("success", "🔄 ") + theme.fg("accent", details.label);
			text += theme.fg("dim", ` (${details.mode})`);
			text += `\n  ${theme.fg("dim", `Log: ${details.logPath}`)}`;
			return new Text(text, 0, 0);
		},
	});

	// ─── list_monitors tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "list_monitors",
		label: "List Monitors",
		description: "List all active and recently completed task monitors.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (monitors.size === 0) {
				return {
					content: [{ type: "text" as const, text: "No active monitors." }],
					details: { monitors: [] },
				};
			}

			const entries = [...monitors.values()].map((m) => {
				const elapsed = formatDuration(Date.now() - m.startTime);
				const status = m.finished
					? m.exitCode === 0
						? "✅ completed"
						: `❌ failed (exit ${m.exitCode})`
					: "🔄 running";
				return {
					label: m.label,
					mode: m.mode,
					status,
					elapsed,
					command: m.command,
					logPath: m.logPath,
					pollCount: m.pollCount,
					outputLines: m.outputBuffer.length,
					retryCount: m.retryCount,
					maxRetries: m.maxRetries,
				};
			});

			const text = [...monitors.values()].map((m) => formatListEntry(m)).join("\n\n");

			return {
				content: [{ type: "text" as const, text }],
				details: { monitors: entries },
			};
		},
	});

	// ─── cancel_monitor tool ─────────────────────────────────────────────

	pi.registerTool({
		name: "cancel_monitor",
		label: "Cancel Monitor",
		description: "Cancel a running task monitor by label.",
		parameters: Type.Object({
			label: Type.String({ description: "Label of the monitor to cancel" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entry = monitors.get(params.label);
			if (!entry) {
				throw new Error(`No monitor found with label '${params.label}'`);
			}
			if (entry.finished) {
				return {
					content: [{ type: "text" as const, text: `Monitor '${params.label}' already finished.` }],
					details: { label: params.label, alreadyFinished: true },
				};
			}

			// Pass cancel reason directly — don't repurpose entry.error as a flag
			finishMonitor(entry, 130, "Cancelled by user");

			updateWidget(ctx);

			return {
				content: [{ type: "text" as const, text: `Monitor '${params.label}' cancelled.` }],
				details: { label: params.label, cancelled: true },
			};
		},
	});

	// ─── check_monitor tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "check_monitor",
		label: "Check Monitor",
		description: "Check the current status and recent output of a monitor without waiting for completion.",
		parameters: Type.Object({
			label: Type.String({ description: "Label of the monitor to check" }),
			tailLines: Type.Optional(Type.Number({ description: "Number of tail lines to return (default: 30)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const entry = monitors.get(params.label);
			if (!entry) {
				throw new Error(`No monitor found with label '${params.label}'`);
			}

			const elapsed = formatDuration(Date.now() - entry.startTime);
			const tail = getTail(entry, params.tailLines ?? 30);
			const status = entry.finished
				? entry.exitCode === 0
					? "✅ completed"
					: `❌ failed (exit ${entry.exitCode})`
				: "🔄 running";

			let text = `**${status}** — ${entry.label} (${elapsed})`;
			if (entry.mode === "poll") text += `\nPolls: ${entry.pollCount}`;
			text += `\nOutput lines: ${entry.outputBuffer.length}`;
			text += `\nLog: ${entry.logPath}`;
			if (tail) {
				text += `\n\n**Recent output:**\n\`\`\`\n${tail}\n\`\`\``;
			}

			return {
				content: [{ type: "text" as const, text }],
				details: {
					label: entry.label,
					status: entry.finished ? (entry.exitCode === 0 ? "completed" : "failed") : "running",
					elapsed,
					exitCode: entry.exitCode,
					pollCount: entry.pollCount,
					outputLines: entry.outputBuffer.length,
					logPath: entry.logPath,
				},
			};
		},
	});

	// ─── Message Renderers ───────────────────────────────────────────────

	pi.registerMessageRenderer("task-monitor-heartbeat", (message, _options, theme) => {
		const text = theme.fg("dim", message.content ?? "");
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer("task-monitor-complete", (message, options, theme) => {
		const details = message.details as any;
		const emoji = details?.success ? "✅" : "❌";
		const statusColor = details?.success ? "success" : "error";

		let text = theme.fg(statusColor, `${emoji} Monitor: ${details?.label ?? "unknown"}`);
		text += theme.fg("dim", ` — ${details?.elapsed ?? ""}`);

		if (options.expanded) {
			text += `\n${message.content ?? ""}`;
		}

		return new Text(text, 0, 0);
	});
}
