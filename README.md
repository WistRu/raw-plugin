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
  in a terminal, one subagent per role instead. Two ids per session, never
  mixed: the desktop address (`local_...`, what a message is sent to) and the
  engine's own id (what a session binds itself with). The brief's first line
  binds the new session to its role before the model reads a word; the
  binding lives in the plugin's store, so a worktree or a `/clear` (a new
  engine id, no restart) does not lose it. A member's session reads its
  card, zone and rules in the system prompt, a static text that leaves the
  prompt cache alone; the live queue and board come through the tools.
- **The ledger** (`mcp__rp__team_task`): `add`, `set`, `list`, `board`,
  `queue`. `blocked` and `ready` follow from `depends_on`; `done` wakes every
  task that waited, `awaiting_verify` wakes the verifier, `failed`/`dropped`
  ask the dependents' owners to decide; a task with a verifier is marked
  `done`, or has its verifier changed, only by that verifier or the lead.
  `team.json` and `tasks.json` are written under a `mkdir` lock and through a
  rename, since several sessions write them; a file that does not parse is
  an error, never an empty ledger.
- **Waking a role** (`mcp__rp__team_notify`, or `sh notify.sh <role> "<what>"`
  from a shell job): a message to the role's session when it has one, else
  an event file in its inbox, which the lead's session delivers every minute
  (as data, not as an instruction); after five polls that cannot reach a
  role, the lead is told once that its session may be gone.
- **The handoff note** (`mcp__rp__team_handoff`): the role writes its queue
  block; the plugin adds the stamp, the session id and the context reading,
  and after every turn leaves `handoff/<role>.state.json` for the board.
  Deliveries and the session's end are appended under the note's `## Inbox`.
- **The zone guard**: a member's Edit, Write, MultiEdit or NotebookEdit outside
  its zone, its own note and its inbox is refused with the owner to ask. A
  Bash command is read for what it writes (`hooks/team/bashzone.ts`: `>`,
  `sed -i`, `tee`, `cp`, `mv`, `rm`, `mkdir`, `git add`/`commit`/`mv`/`rm` with
  their paths; `git stash`/`reset`/`checkout`/`clean` and `git add -A` as the
  whole tree) and refused the same way; quotes are stripped, not parsed, so
  the reading is conservative.
- **The critics**, four layers that drive the error rate down:
  1. `mcp__rp__team_audit`, no model: every figure in a result must appear
     in a tool output of the session, every quoted command must have been
     run, every file said written must exist and be newer than the session,
     "tests pass" needs a passing run, "committed" needs `git commit`, and
     every `a + b = c` or `x of y = p %` is recomputed (`hooks/team/audit.ts`).
  2. `mcp__rp__team_critic`, the subagent `rp:critic` on Opus with read-only
     tools: the audit's lines, claim cards (claim, source, reproduced,
     falsifier), one figure reproduced, a twelve-line checklist plus the
     team's own, the breaker. `mode: heavy` adds a second critic for the
     logic (premises, rivals, scope). Findings are lines
     `F<n> [status] BLOCKING|NOTE|QUESTION USER|AGENT -- text`, kept as a
     run under `critic/`.
  3. `mcp__rp__team_answer`: the debate. The author answers each finding
     with evidence (fixed, refuted, user, cannot); the critic re-checks and
     sets `SETTLED-FIXED`, `SETTLED-WRONG`, `USER` or `OPEN`; three rounds at
     most, an honest `OPEN` is a valid end. With a task id the run is
     recorded on the task, and `awaiting_verify` is refused while a blocking
     finding is open (`force` skips, saying why).
  4. `mcp__rp__team_review`: the critic of the whole session, from a digest
     of the transcript (`review/digest-<k>.md`): the main claims of the user
     and the agent alike, the key ones verified, prior work, the checklist,
     the breaker; earlier reviews are read first and their ledgers carried
     over. Its `USER` findings go to the person as they stand.
  What the team learns: `mcp__rp__team_checklist add` appends one dated line
  per settled mistake (`CHECKLIST.md`, read by every critic, never
  reworded); `mcp__rp__team_predict` records what a role expects before a
  run and resolves it after, and the critics quote the score where the role
  speaks with certainty. The board (`team_task board`, `/team status`) shows
  per role the blocking findings found, fixed, refuted and open, and the
  prediction score.
- **The roster** (`mcp__rp__team_role`, the lead's): park a role (its messages
  wait in its inbox), wake it, add a role, or start (or restart) a role's
  session. `/team close` tells every member, and a member's binding ends.
- **After a restart**: a session finds its team by its engine id (the
  plugin's store), by its desktop address (`team.json`) when the id changed,
  or by the brief; a `/clear` or a resume carries the membership over.
- **`/team status`** draws the board (a pane in the lead's session,
  `team_task board` for the model); **`/team close`** ends the team and
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
