# Raw Plugin (`rp`)

The operator's own harness for Claude Code: the behaviour that should follow
them to any machine, project and session, as one plugin. Each module is a
folder under `hooks/`, composed by `hooks/register.ts`.

## Modules

### resource-guard

Claude Code knows what the machine can carry and never overloads it.

- **Measures the machine** at session start (cores, RAM, swap) and tells the
  model in a short system-prompt section; refreshes the status line every 10 s
  (`RAM 13.0/30.2G · swap 15.1G · cpu 1.3/6 · jobs 1`).
- **Every Bash command is heavy unless it is plain file, text or git work**
  (`git`, `ls`, `cat`, `grep`, quick verbs of `cargo`/`npm`/`python`, …:
  the list is `LIGHT` in `hooks/resource-guard/commands.ts`). A heavy command
  is held, with the figures, while less than 25 % of RAM is available or all
  cores are busy; the model then waits or runs fewer jobs in parallel.
- **Remembers what each command took**: on Linux the peak memory of every run
  is recorded per command signature, and next time the command is held unless
  that much is free on top of the reserve.
- **Starts heavy commands one at a time**: the next one waits until the
  previous one's memory stops growing (or 20 s).
- **Linux with systemd**: heavy commands run inside a memory slice the plugin
  makes at session start from this machine's RAM (`claude-heavy.slice`,
  slowed down above 60 % of RAM, killed at 80 %, swap capped at half). Desktop
  apps are never touched. A kill (exit 137) is explained to the model.
- **Elsewhere** (macOS, Windows, Linux without systemd): a watchdog stops the
  newest own job when available RAM falls under 1 GB, so the desktop survives.
- **Tool and commands**: `mcp__rp__resources` for the model (call it
  before sizing a batch); `/rp:resources` (or `/resources`) for the person;
  `/rp:setup` (or `/resources setup`) shows how to make Linux swap Mac-like (`hooks/resource-guard/setup-swap.sh`:
  zram first, disk files on demand; hinted once per machine).
- **Holds heavy commands also when the disk is 95 % full** (from sysmon's
  sample on Linux). Temperature is shown, never a reason to wait.
- On Linux the guard reads sysmon's half-second sample instead of spawning
  its own probe; the probe script runs at session start and elsewhere.
- Thresholds are constants at the top of `hooks/resource-guard/index.ts`.

### sysmon

A live system monitor pane: CPU per core, GPU, RAM, swap, disk space and
I/O, network, temperatures, fan, battery, the busiest and biggest programs.
`/rp:sysmon` (or `/sysmon`) opens it; `/sysmon line` turns the one-line
summary under the prompt off and on (the guard draws that line, with GPU and
temperature when known). Linux only: it reads `/proc` and `/sys`.

Known limits: processes the plugin did not start are only counted, never
capped; the macOS and Windows probes were written without a machine to run
them on; inside the slice `cd` does not carry over to the next command.

### team

A team of sessions for one task, drafted per task and tied together by a
folder.

- **`/team <task>`** has the model draft 2-6 roles (lane, zone of paths it may
  edit, deliverable, verifier) and the first tasks, show them, then call
  `mcp__rp__team_create`, which asks once more and lays the folder out:
  `.claude/teams/<slug>/` in the project (`CARD.md`, `tasks.json`,
  `handoff/<role>.md`, `inbox/<role>/`, `notify.sh`, a `.gitignore` of `*`).
  The session that created the team is its lead.
- **One session per role** through the desktop app's `start_session` tool;
  in a terminal, one subagent per role instead. A member's session reads its
  card, zone, rules and the queue of its note in the system prompt; the lead
  reads the board.
- **The ledger** (`mcp__rp__team_task`): `add`, `set`, `list`, `board`.
  `blocked` and `ready` follow from `depends_on`; `done` wakes every task that
  waited, `awaiting_verify` wakes the verifier, `failed`/`dropped` ask the
  dependents' owners to decide; a task with a verifier is marked `done` only
  by that verifier or the lead.
- **Waking a role** (`mcp__rp__team_notify`, or `sh notify.sh <role> "<what>"`
  from a shell job): an event file in the role's inbox plus a message to its
  session; what no session received, the lead's session delivers every
  minute.
- **The handoff note** (`mcp__rp__team_handoff`): the role writes its queue
  block; the plugin adds the stamp, the session id and the context reading,
  and after every turn leaves `handoff/<role>.state.json` for the board.
  Deliveries and the session's end are appended under the note's `## Inbox`.
- **The zone guard**: a member's Edit, Write, MultiEdit or NotebookEdit outside
  its zone and the team folder is refused with the owner to ask.
- **`/team status`** draws the board (a pane in the lead's session,
  `mcp__rp__team_status` for the model); **`/team close`** ends the team and
  asks for the final report in one schema: done · worked or not · next.

Ported from BTC5Model's convergence roles (card, handoff notes,
`role_tasks.py`, `role_inbox.py`, `/resume-role`, `/role-handoff`) with the
hourly ticks, the clear-and-resend dance and the project's own rules left
out. Not yet tried against a live desktop: whether `start_session` can be
called from a hook, and whether a message a plugin sends wakes the other
session, are the first two things to check.

## Install

```
/plugin install rp --marketplace WistRu/raw-plugin
```

Answer `y` to add the marketplace, then pick the user scope. From a local
checkout: `claude plugin marketplace add /path/to/raw-plugin` and
`claude plugin install rp@raw --scope user`.

## Develop

```
claude plugin validate .
claude plugin test .
```
