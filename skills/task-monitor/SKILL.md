---
name: task-monitor
description: Use when the user asks to run, monitor, or watch a long-running process (build, test, deploy, training job, data sync). Also use when the user says "kick off", "run in background", "monitor until done", "watch this", or asks about CloudFormation/Terraform deployment status. Provides monitor_task, list_monitors, cancel_monitor, and check_monitor tools.
---

# Task Monitor

Use `monitor_task` instead of `bash` for any command expected to take more than ~30 seconds.
The agent is freed immediately and woken up with full output context when the process finishes.

## Two Modes

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
Run a command on an interval, match output patterns for completion or failure.
Use for deployments, CI pipelines, remote job status.

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

## Key Parameters

| Parameter | Mode | Description |
|-----------|------|-------------|
| `command` | both | Shell command to execute |
| `label` | both | Short unique name (shown in tmux title, widget) |
| `mode` | both | `"watch"` or `"poll"` |
| `tailLines` | both | Lines of output tail in wake-up message (default: 100) |
| `heartbeat` | both | FYI status interval in seconds (default: none) |
| `heartbeatTrigger` | both | `true` to wake agent on each heartbeat for remote relay (default: false) |
| `maxRetries` | watch | Auto-restart on failure with exponential backoff (default: 0) |
| `retryBackoffMs` | watch | Initial backoff before first retry (default: 2000ms) |
| `retryMaxBackoffMs` | watch | Max backoff cap (default: 60000ms) |
| `pollInterval` | poll | Seconds between polls (default: 30) |
| `untilPatterns` | poll | Strings that indicate success when found in output |
| `failPatterns` | poll | Strings that indicate failure when found in output |
| `maxDuration` | poll | Timeout in seconds (default: none) |

## Management Tools

- `list_monitors` — show all active and recently completed monitors
- `check_monitor({ label })` — peek at current status + recent output without waiting
- `cancel_monitor({ label })` — kill a running monitor

## When the Process Finishes

The agent is woken up via `triggerTurn` with:
- Exit code (0 = success, non-zero = failure)
- Last N lines of output (configurable via `tailLines`)
- Full log path at `~/.pi/monitors/{label}-{timestamp}.log`
- Duration, retry count, poll count
- Pattern match reason (poll mode)

The agent should then **analyze the output and recommend next steps** to the user.

## Common Patterns

**Flaky test suite with retries:**
```
monitor_task({
  command: "pytest tests/ -x",
  label: "tests",
  mode: "watch",
  maxRetries: 2,
  retryBackoffMs: 5000,
  heartbeat: 30
})
```

**Docker build:**
```
monitor_task({
  command: "docker build -t myapp:latest .",
  label: "docker-build",
  mode: "watch",
  tailLines: 50,
  heartbeat: 30
})
```

**Terraform apply:**
```
monitor_task({
  command: "terraform output -json | jq -r '.status.value'",
  label: "tf-apply",
  mode: "poll",
  pollInterval: 15,
  untilPatterns: ["applied", "complete"],
  failPatterns: ["error", "failed"],
  maxDuration: 600
})
```

**Training job on remote GPU:**
```
monitor_task({
  command: "ssh gpu-box 'tail -1 /tmp/training/progress.log'",
  label: "training",
  mode: "poll",
  pollInterval: 60,
  untilPatterns: ["Training complete", "Final accuracy"],
  failPatterns: ["CUDA error", "OOM", "Traceback"],
  maxDuration: 7200,
  heartbeat: 300
})
```

**SageMaker training job:**
```
monitor_task({
  command: "aws sagemaker describe-training-job --training-job-name my-job --query 'TrainingJobStatus' --output text",
  label: "sagemaker",
  mode: "poll",
  pollInterval: 60,
  untilPatterns: ["Completed"],
  failPatterns: ["Failed", "Stopped"],
  maxDuration: 14400,
  heartbeat: 300
})
```

## Decision Guide

| Situation | Use |
|-----------|-----|
| Command runs once, takes > 30s | `monitor_task` watch mode |
| Need to check status of a remote/async operation | `monitor_task` poll mode |
| Command takes < 30s | `bash` (regular tool) |
| Need interactive input during execution | `bash` or `interactive_shell` |
| Running another AI coding agent | `interactive_shell` dispatch mode |
