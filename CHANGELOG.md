# Changelog

## 0.1.0 (2026-04-11)

### Features

- **Watch mode** — spawn long-running processes, monitor until exit, wake agent with output
- **Poll mode** — run commands on interval with pattern matching for completion/failure
- **Self-healing retries** — exponential backoff with configurable `maxRetries` (watch mode)
- **Heartbeats** — periodic FYI status (`heartbeat`) or triggering (`heartbeatTrigger: true`)
- **Tmux title** — live `🔄 label (Xm Ys)` while running, `✅`/`❌` on completion
- **Widget** — persistent status bar below editor showing active monitors
- **Concurrent monitors** — multiple simultaneous monitors with aggregate tmux title
- **Project-local logs** — `.pi/monitors/{label}-{timestamp}.log`
- **7-day auto-cleanup** — old logs pruned on session start
- **Orphan detection** — PID tracking with user confirmation before killing
- **Guardrails enforcement** — commands checked via pi-guardrails `tool_call` hook
- **Skill file** — agent guidance for when and how to use monitor tools

### Tools

- `monitor_task` — kick off and auto-monitor a background process
- `list_monitors` — show all active and recently completed monitors
- `check_monitor` — peek at current status and recent output
- `cancel_monitor` — kill a running monitor

### Bug Fixes

- `deliverAs: "nextTurn"` for heartbeats prevents tool call interruption
- `deliverAs: "followUp"` for completions waits for current tools to finish
- Stripped raw markdown `**` from plain-text heartbeat messages
