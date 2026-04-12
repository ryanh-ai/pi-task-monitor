// ─── Pure utility functions extracted for testability ─────────────────────────

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MonitorEntry {
	label: string;
	command: string;
	cwd: string;
	mode: "watch" | "poll";
	startTime: number;
	process: any;
	logPath: string;
	outputBuffer: string[];
	maxBufferLines: number;
	tailLines: number;
	heartbeatInterval: number | null;
	heartbeatTrigger: boolean;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	pollInterval?: number;
	pollTimer?: ReturnType<typeof setInterval> | null;
	pollCount?: number;
	lastPollOutput?: string;
	untilPatterns?: string[];
	failPatterns?: string[];
	activePollProc?: any;
	maxDuration?: number;
	maxDurationTimer?: ReturnType<typeof setTimeout> | null;
	maxRetries: number;
	retryCount: number;
	retryBackoffMs: number;
	retryMaxBackoffMs: number;
	exitCode: number | null;
	finished: boolean;
	error?: string;
}

// ─── Duration Formatting ─────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rs = s % 60;
	if (m < 60) return `${m}m${rs > 0 ? ` ${rs}s` : ""}`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return `${h}h${rm > 0 ? ` ${rm}m` : ""}`;
}

// ─── Output Buffer Management ────────────────────────────────────────────────

export function bufferOutput(entry: Pick<MonitorEntry, "outputBuffer" | "maxBufferLines">, data: string) {
	const lines = data.split("\n");
	for (const line of lines) {
		entry.outputBuffer.push(line);
	}
	while (entry.outputBuffer.length > entry.maxBufferLines) {
		entry.outputBuffer.shift();
	}
}

export function getTail(entry: Pick<MonitorEntry, "outputBuffer" | "tailLines">, n?: number): string {
	const count = n ?? entry.tailLines;
	const lines = entry.outputBuffer.slice(-count);
	return lines.join("\n").trim();
}

// ─── Log Management ──────────────────────────────────────────────────────────

export function createLogPath(logDir: string, label: string): string {
	mkdirSync(logDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	return join(logDir, `${label}-${ts}.log`);
}

export function cleanupOldLogs(logDir: string, maxAgeMs: number): number {
	if (!existsSync(logDir)) return 0;

	const now = Date.now();
	let cleaned = 0;

	try {
		const files = readdirSync(logDir).filter((f) => f.endsWith(".log"));
		for (const file of files) {
			try {
				const filePath = join(logDir, file);
				const stat = statSync(filePath);
				if (now - stat.mtimeMs > maxAgeMs) {
					unlinkSync(filePath);
					cleaned++;
				}
			} catch {
				/* skip */
			}
		}
	} catch {
		/* dir read error */
	}

	return cleaned;
}

// ─── PID File Management ─────────────────────────────────────────────────────

export interface PidFileData {
	label: string;
	parentPid: number;
	childPid: number | null;
	startedAt: number;
}

export function writePidFile(pidDir: string, label: string, parentPid: number, childPid: number | undefined) {
	try {
		mkdirSync(pidDir, { recursive: true });
		const pidFile = join(pidDir, `${label}.json`);
		writeFileSync(
			pidFile,
			JSON.stringify({
				label,
				parentPid,
				childPid: childPid ?? null,
				startedAt: Date.now(),
			}),
		);
	} catch {
		/* best effort */
	}
}

export function removePidFile(pidDir: string, label: string) {
	try {
		const pidFile = join(pidDir, `${label}.json`);
		if (existsSync(pidFile)) unlinkSync(pidFile);
	} catch {
		/* best effort */
	}
}

export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function findOrphans(pidDir: string): PidFileData[] {
	const orphans: PidFileData[] = [];
	if (!existsSync(pidDir)) return orphans;

	try {
		const files = readdirSync(pidDir).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			try {
				const data = JSON.parse(readFileSync(join(pidDir, file), "utf-8")) as PidFileData;
				if (data.parentPid && !isProcessRunning(data.parentPid)) {
					orphans.push(data);
				}
			} catch {
				/* malformed file, skip */
			}
		}
	} catch {
		/* dir read error */
	}

	return orphans;
}

// ─── Label Sanitization ─────────────────────────────────────────────────────

export function sanitizeLabel(label: string): string {
	return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ─── Retry Backoff Calculation ───────────────────────────────────────────────

export function calculateBackoff(retryCount: number, baseMs: number, maxMs: number): number {
	return Math.min(baseMs * 2 ** (retryCount - 1), maxMs);
}

// ─── Pattern Matching (for poll mode) ────────────────────────────────────────

export function matchesAnyPattern(output: string, patterns: string[]): string | null {
	for (const pattern of patterns) {
		if (output.includes(pattern)) return pattern;
	}
	return null;
}

// ─── Retry Decision Logic ────────────────────────────────────────────────────

export function shouldRetry(
	entry: Pick<MonitorEntry, "mode" | "retryCount" | "maxRetries">,
	exitCode: number | null,
	reason?: string,
): boolean {
	const wasCancelled = reason === "Cancelled by user";
	const isPatternMatch = reason?.startsWith("Matched ");
	return (
		entry.mode === "watch" &&
		exitCode !== 0 &&
		exitCode !== null &&
		!wasCancelled &&
		!isPatternMatch &&
		entry.retryCount < entry.maxRetries
	);
}

// ─── Heartbeat Status Formatting ─────────────────────────────────────────────

export function buildHeartbeatStatus(
	entry: Pick<
		MonitorEntry,
		"label" | "mode" | "startTime" | "outputBuffer" | "retryCount" | "maxRetries" | "pollCount" | "lastPollOutput"
	>,
): string {
	const elapsed = formatDuration(Date.now() - entry.startTime);
	const lineCount = entry.outputBuffer.length;
	let status = `🔄 ${entry.label} — running ${elapsed}, ${lineCount} lines`;

	if (entry.retryCount > 0) {
		status += ` (retry ${entry.retryCount}/${entry.maxRetries})`;
	}

	if (entry.mode === "poll") {
		status += `, poll #${entry.pollCount ?? 0}`;
		if (entry.lastPollOutput) {
			const lastLine = entry.lastPollOutput.split("\n").pop()?.trim() ?? "";
			if (lastLine) {
				status += `\nLast: \`${lastLine.slice(0, 120)}\``;
			}
		}
	} else {
		// Show last meaningful line from buffer
		const tail = getTail(entry, 1);
		if (tail) {
			status += `\nLast: \`${tail.slice(0, 120)}\``;
		}
	}

	return status;
}

// ─── Completion Message Building ─────────────────────────────────────────────

export function buildCompletionMessage(
	entry: Pick<
		MonitorEntry,
		| "label"
		| "command"
		| "mode"
		| "startTime"
		| "outputBuffer"
		| "tailLines"
		| "retryCount"
		| "maxRetries"
		| "pollCount"
		| "error"
		| "logPath"
	>,
	exitCode: number | null,
	reason?: string,
): string {
	const success = exitCode === 0;
	const elapsed = formatDuration(Date.now() - entry.startTime);
	const tail = getTail(entry);

	const emoji = success ? "✅" : "❌";
	let content = `${emoji} **Monitor: ${entry.label}** — ${success ? "completed successfully" : "failed"} (${elapsed})`;
	content += `\n**Command:** \`${entry.command}\``;
	content += `\n**Exit code:** ${exitCode}`;
	if (entry.retryCount > 0) content += `\n**Retries:** ${entry.retryCount}/${entry.maxRetries}`;
	if (reason) content += `\n**Reason:** ${reason}`;
	if (entry.error) content += `\n**Error:** ${entry.error}`;
	if (entry.mode === "poll") content += `\n**Polls:** ${entry.pollCount}`;
	content += `\n**Log:** \`${entry.logPath}\``;
	if (tail) {
		content += `\n\n**Last ${entry.tailLines} lines of output:**\n\`\`\`\n${tail}\n\`\`\``;
	}
	content += `\n\nPlease analyze the output and recommend next steps.`;

	return content;
}

// ─── Widget Line Building ────────────────────────────────────────────────────

export function buildWidgetLines(
	entries: Pick<
		MonitorEntry,
		"label" | "mode" | "startTime" | "pollCount" | "retryCount" | "maxRetries" | "finished"
	>[],
): string[] | null {
	const active = entries.filter((m) => !m.finished);
	if (active.length === 0) return null;

	const lines = active.map((m) => {
		const elapsed = formatDuration(Date.now() - m.startTime);
		const pollInfo = m.mode === "poll" ? ` ⟳${m.pollCount ?? 0}` : "";
		const retryInfo = m.retryCount > 0 ? ` ♻${m.retryCount}/${m.maxRetries}` : "";
		return `  🔄 ${m.label} (${elapsed}${pollInfo}${retryInfo})`;
	});

	return ["📡 Monitors:", ...lines];
}

// ─── List Entry Formatting ───────────────────────────────────────────────────

export function formatListEntry(
	entry: Pick<
		MonitorEntry,
		| "label"
		| "mode"
		| "startTime"
		| "command"
		| "logPath"
		| "pollCount"
		| "outputBuffer"
		| "retryCount"
		| "maxRetries"
		| "finished"
		| "exitCode"
	>,
): string {
	const elapsed = formatDuration(Date.now() - entry.startTime);
	const status = entry.finished
		? entry.exitCode === 0
			? "✅ completed"
			: `❌ failed (exit ${entry.exitCode})`
		: "🔄 running";

	let line = `${status} ${entry.label} (${entry.mode}, ${elapsed})`;
	if (entry.mode === "poll") line += ` polls: ${entry.pollCount}`;
	if (entry.retryCount > 0) line += ` retries: ${entry.retryCount}/${entry.maxRetries}`;
	line += `\n  cmd: ${entry.command}\n  log: ${entry.logPath}`;
	return line;
}

// ─── Monitor Entry Factory (for testing) ─────────────────────────────────────

export function createMonitorEntry(
	overrides: Partial<MonitorEntry> & { label: string; command: string },
): MonitorEntry {
	return {
		cwd: "/tmp",
		mode: "watch",
		startTime: Date.now(),
		process: null,
		logPath: "/tmp/test.log",
		outputBuffer: [],
		maxBufferLines: 5000,
		tailLines: 100,
		heartbeatInterval: null,
		heartbeatTrigger: false,
		heartbeatTimer: null,
		pollInterval: 30,
		pollTimer: null,
		pollCount: 0,
		lastPollOutput: undefined,
		activePollProc: null,
		untilPatterns: undefined,
		failPatterns: undefined,
		maxDuration: undefined,
		maxDurationTimer: null,
		maxRetries: 0,
		retryCount: 0,
		retryBackoffMs: 2000,
		retryMaxBackoffMs: 60000,
		exitCode: null,
		finished: false,
		error: undefined,
		...overrides,
	};
}
