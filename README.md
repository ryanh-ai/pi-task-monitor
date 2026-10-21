> [!CAUTION]
> **Archived and no longer maintained.** Use [pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) instead:
>
> | pi-task-monitor | pi-interactive-shell |
> |---|---|
> | `monitor_task` watch mode | `interactive_shell({ command, mode: "dispatch", background: true })` |
> | `monitor_task` poll mode | `interactive_shell({ command, mode: "monitor", monitor: { strategy: "poll-diff", triggers: [...] } })` |
> | `list_monitors` / `check_monitor` / `cancel_monitor` | `listBackground`, `sessionId` queries, `kill`, `/attach` |
>
> Monitor mode also supports `stream` (log line) and `file-watch` triggers. For background agent work, use [pi-subagents](https://github.com/nicobailon/pi-subagents) async runs. Retries and heartbeats have no direct replacement; wrap the command in a shell retry loop if needed.

> [!WARNING]
> **Forkware** — This project is shared as-is for learning and forking. It works for me; it might work for you. No guarantees, no support promises, no roadmap commitments. Fork it, hack it, make it yours.

# pi-task-monitor

Pi extension for background task monitoring with auto-wakeup. Kick off long-running tasks, monitor them until completion, and wake the coding agent with full output context for analysis.

## Installation

```bash
pi install git:github.com/ryanh-ai/pi-task-monitor
```

## Features

- **Watch mode** — spawn a process, monitor until exit, wake agent on completion
- **Poll mode** — run a command on interval, pattern-match for completion/failure
- **Self-healing retries** — exponential backoff with configurable max retries (watch mode)
- **Heartbeats** — periodic FYI status updates or triggering heartbeats for remote relay
- **Tmux title** — live status emoji while running (🔄), completion state (✅/❌)
- **Widget** — persistent status bar below editor showing active monitors
- **Concurrent monitors** — run multiple monitors simultaneously
- **Project-local logs** — `.pi/monitors/{label}-{timestamp}.log`
- **7-day auto-cleanup** — old logs pruned on session start
- **Orphan detection** — PID tracking with user confirmation before killing
- **Guardrails enforcement** — commands checked by pi-guardrails (not an escape hatch)
- **Skill file** — teaches the agent when and how to use the tools

## Tools

| Tool | Description |
|------|-------------|
| `monitor_task` | Kick off a background process and get woken up when it completes |
| `list_monitors` | Show all active and recently completed monitors |
| `check_monitor` | Peek at current status and recent output |
| `cancel_monitor` | Kill a running monitor |

## Usage

### Watch Mode — long-running processes

Run a command once, monitor until it exits. Use for builds, tests, training jobs, scripts.

```
monitor_task({
  command: "npm test",
  label: "tests",
  mode: "watch",
  tailLines: 100,
  heartbeat: 60
})
```

### Poll Mode — check status repeatedly

Run a command on an interval, match output patterns for completion or failure. Use for deployments, CI pipelines, remote job status.

```
monitor_task({
  command: "aws cloudformation describe-stacks --stack-name my-stack --query 'Stacks[0].StackStatus' --output text",
  label: "cfn-deploy",
  mode: "poll",
  pollInterval: 30,
  untilPatterns: ["CREATE_COMPLETE", "UPDATE_COMPLETE"],
  failPatterns: ["ROLLBACK", "FAILED", "DELETE"],
  maxDuration: 1800,
  heartbeat: 120
})
```

### Self-Healing Retries

Auto-restart failed processes with exponential backoff (watch mode only).

```
monitor_task({
  command: "pytest tests/ -x",
  label: "tests",
  mode: "watch",
  maxRetries: 3,
  retryBackoffMs: 2000,
  retryMaxBackoffMs: 60000
})
```

### Heartbeat for Remote Relay

Use `heartbeatTrigger: true` when the agent needs to relay status to Slack, Discord, etc.

```
monitor_task({
  command: "python train.py",
  label: "training",
  mode: "watch",
  heartbeat: 300,
  heartbeatTrigger: true
})
```

## Parameters

| Parameter | Mode | Description |
|-----------|------|-------------|
| `command` | both | Shell command to execute |
| `label` | both | Short unique name (shown in tmux title, widget) |
| `mode` | both | `"watch"` or `"poll"` |
| `cwd` | both | Working directory (defaults to current) |
| `tailLines` | both | Lines of output tail in wake-up message (default: 100) |
| `heartbeat` | both | FYI status interval in seconds (default: none) |
| `heartbeatTrigger` | both | `true` to wake agent on each heartbeat (default: false) |
| `maxRetries` | watch | Auto-restart on failure with backoff (default: 0) |
| `retryBackoffMs` | watch | Initial backoff ms (default: 2000) |
| `retryMaxBackoffMs` | watch | Max backoff cap ms (default: 60000) |
| `pollInterval` | poll | Seconds between polls (default: 30) |
| `untilPatterns` | poll | Strings indicating success when found in output |
| `failPatterns` | poll | Strings indicating failure when found in output |
| `maxDuration` | poll | Timeout in seconds (default: none) |

## What Happens

1. **Agent returns immediately** — tells the user it's monitoring
2. **Tmux title** shows `🔄 tests (2m 14s)` while running
3. **Widget** below editor shows active monitors
4. **Heartbeats** (if configured) send periodic FYI status
5. **On completion** → agent wakes up with exit code, last N lines of output, log path, duration
6. **Tmux title** flashes `✅ tests` or `❌ tests` for 5 seconds

## Guardrails

Commands are checked by [pi-guardrails](https://github.com/ryanh-ai/pi-guardrails) via the `tool_call` event hook. The guardrails extension inspects `event.input.command` on `monitor_task` the same way it checks `bash` commands. Auto-deny patterns block immediately, dangerous patterns prompt the user for confirmation.

This is **not** an escape hatch around guardrails.

## Logs & Process Management

- **Logs** are stored in `.pi/monitors/` in the project directory (project-local)
- **Auto-cleanup** removes logs older than 7 days on session start
- **PID files** track active monitors in `.pi/monitors/.pids/` for orphan detection
- **Orphan detection** on session start checks for monitors from crashed pi sessions
- **User confirmation** before killing orphaned processes

## Development

```bash
npm install
npm test            # Run tests
npm run lint        # Check linting
npm run lint:fix    # Auto-fix lint issues
npm run format      # Format code
npm run check       # Lint + test
```

## Roadmap

- **Tmux pane support** — spawn monitors in visible tmux panes for live visual monitoring
- **Tool-based polling** — poll using any pi tool (`fetch_content`, `read`, `mcp`) not just shell commands
- **Agent mode** — LLM-interpreted output analysis for ambiguous completion detection
