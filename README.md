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
  1. `mcp__rp__critic_audit`, no model: every figure in a result must appear
     in a tool output of the session, every quoted command must have been
     run, every file said written must exist and be newer than the session,
     "tests pass" needs a passing run, "committed" needs `git commit`, and
     every `a + b = c` or `x of y = p %` is recomputed (`hooks/team/audit.ts`).
  2. `mcp__rp__critic_result`, the subagent `rp:critic` on a model other than
     the session's (Sonnet for a session on Opus, Opus otherwise), its
     Bash, Edit and Write refused when they would write: the audit's lines,
     claim cards (claim, source, reproduced, falsifier), one figure
     reproduced, a twelve-line checklist plus the team's own, the breaker.
     `mode: heavy` adds a second critic for the logic (premises, rivals,
     scope). Findings are lines
     `F<n> [status] BLOCKING|NOTE|QUESTION USER|AGENT -- text`, kept as a
     run under `critic/`.
  3. `mcp__rp__critic_answer`: the debate. The author answers each finding
     with evidence (fixed, refuted, user, cannot); the critic re-checks and
     sets `SETTLED-FIXED`, `SETTLED-WRONG`, `USER` or `OPEN`; three rounds at
     most, an honest `OPEN` is a valid end. With a task id the run is
     recorded on the task, and `awaiting_verify` is refused while a blocking
     finding is open (`force` skips, saying why).
  4. `mcp__rp__critic_session`: the critic of the whole session, from a digest
     of the transcript (`review/digest-<k>.md`, each message clipped to
     6000 characters, each tool call's input to 600, so an Edit's text is
     not in it, and each tool output to 2000) beside the path of the
     session's full JSONL record, which the critic opens where the digest
     clips something that matters: the main claims of the user and the
     agent alike, the key ones verified, prior work, the checklist, the
     breaker; earlier reviews are read first and their ledgers carried
     over. Its `USER` findings go to the person as they stand. With
     `session: true` (`/critic-session --session`) the critic is a visible
     Claude Desktop session of its own, on the other model, that the
     person can open and talk to; its ledgers arrive as messages, the
     plugin records them on the run, and `critic_answer` sends the author's
     answers to it. Without it, a subagent answers inside the call, which
     blocks the turn until it does (ten minutes at most).
  The six work in any session, team or not (`_sessions/<id>/` beside the
  teams), as tools the model calls or as the person's own commands:
  `/critic-audit <path or text>`, `/critic <path or claim> [--heavy] [--task
  T-NNNN]`, `/critic-session [--session] [focus]`, and `/critic-full <path
  or claim> [--session] [--task T-NNNN]`, the whole cycle on one result:
  the command runs the audit and both critics, then leaves the model the
  steps only the author can take (answer each finding with evidence, round
  until no blocking finding is open, the session critic last, the report).
  What the team learns: `mcp__rp__critic_checklist add` appends one dated line
  per settled mistake (`CHECKLIST.md`, read by every critic, never
  reworded); `mcp__rp__critic_predict` records what a role expects before a
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
  `team_task board` for the model); **`/team close`** (or the lead's
  `mcp__rp__team_close`, with `archive: true` to archive the role sessions
  through the app when the person agreed) ends the team and asks for the
  final report in one schema: done · worked or not · next.
- **Cost in every session**: the plugin is installed at user scope, so the
  membership check runs on every Bash, Edit and Write of every session on
  the machine; outside a team it costs one listing of the teams folder per
  minute and nothing else.
- **Tried live on 2026-10-21** (a two-role toy team, then a one-role wake
  test, in Claude Desktop): the sessions start from the hook, bind from
  the brief, message the lead and each other, the critic gate and the
  verifier wake work, the lead's poll delivers a waiting event, and a role
  whose session was idle (its turn over for 45 s, `isRunning: false`) was
  woken by `team_notify` and answered; which of the two delivery paths
  carried it is not recorded. Not yet seen live: a role session after the
  app restarted, the terminal fallback with subagents, and the review as a
  visible critic session beyond its first ledger.
- **The lock** (`hooks/team/folder.ts`, `withLock`): on Linux a child
  process holds a `flock` on `<team>/.flock` while the ledger or the roster
  is written and watches the session's process, so a killed session, a
  crashed one (an OOM, a `kill -9`) and a plain return all release it
  within a second; `sh hooks/team/lock.test.sh [n]` runs that very script
  with n holders at once and checks no overlap, release on kill, and
  release after the parent's `kill -9`. Without `flock` a `mkdir` lock
  with a stale takeover stands in, with a narrow race named in the code.

Ported from BTC5Model's convergence roles (card, handoff notes,
`role_tasks.py`, `role_inbox.py`, `/resume-role`, `/role-handoff`) with the
hourly ticks, the clear-and-resend dance and the project's own rules left
out. Not yet tried against a live desktop: whether `start_session` can be
called from a hook, and whether a message a plugin sends wakes the other
session, are the first two things to check.

### worktree

Every code change goes in its own git worktree and branch, is landed on the
main branch with a fast-forward, then the worktree and the branch are
deleted. It works in any git repository with no configuration; the engine
makes the worktrees (`EnterWorktree`, the desktop app's worktree checkbox,
agents with `isolation: worktree`), the module adds the rule, its guard and
the landing.

- **What it reads**: the main working tree is `$.session.repo().root`; the
  main branch is what `origin/HEAD` points at, else `main`, else `master`
  (each only when a local branch of that name exists). None of them: the
  module is silent in that repository. "Code" is every file git tracks;
  untracked and ignored paths are never refused. Every path is compared as
  a real path, so a root reached through a symlink is the same tree as its
  target, and the tree a path belongs to is the deepest registered worktree
  that holds it (a worktree nested inside the main tree, such as
  `.claude/worktrees/<name>`, owns its own files).
- **The guard**: Edit, Write, MultiEdit and NotebookEdit on a tracked file of
  the main tree are refused with the way out: `EnterWorktree` (or the app's
  worktree checkbox for a new session), or `/worktree off`. A Bash command is
  read for what it writes by the team module's `hooks/team/bashzone.ts`;
  each path is judged the same way, and a verb that rewrites the whole tree
  (`git commit` with no paths, `git stash`, `git checkout`, `git merge`, ...)
  is refused when the command runs in the main tree. Writes in a worktree
  and outside the repository always go through. A guard that cannot read
  the repository lets the write through and says so once.
- **`/worktree off`** and **`/worktree on`** lift and restore the guard for
  this session (`rp.isWorktreeGuardOn` in `$.state`).
- **The prompt section**: the rule in three lines and where the session
  stands, computed at the session's start and at the start of each turn of
  the main loop, never per request: `Here: main tree of <repo>: code edits
  are refused, enter a worktree first.` or `Here: worktree <path>, branch
  <b>, <n> commits not on <main>, clean|dirty.` The text changes when the
  place does (a commit, an edit), and a changed section is re-sent uncached
  on the next request after it, so it costs a cache write of the
  conversation once per turn in which it changed.
- **The landing** (`/land`, or the tool `mcp__rp__land`): from the session
  that works in the worktree. Each step refuses with its reason and nothing
  after it runs: the worktree is clean (`git status --porcelain` empty); the
  main tree has the main branch checked out and no change to a tracked file
  (untracked files there are left alone, the guard allows them); the branch
  contains the main branch (`git merge-base --is-ancestor <main> HEAD`, else
  "rebase first": the module never rebases); the branch has commits to land;
  `preLand` passes; `git merge --ff-only <branch>` in the main tree; then
  `postLand` (its failure is reported, the landing stands); the session
  leaves the worktree through the engine's `ExitWorktree` with `keep`; `git
  worktree remove <path>` and `git branch -d <branch>`, never `--force`; the
  report lists the landed commits. A session that cannot leave its worktree
  (a folder the desktop app made for it, or a subagent's call) lands and
  keeps the worktree, which `/worktree prune` removes later. Every git call
  goes through `$.process.run` by argument vector, no shell; `preLand` and
  `postLand` written as one string run under `sh -c`, as a list by argument
  vector, ten minutes at most, outside the resource guard's slice.
- **Repository hooks do not fire from `/land`**: the engine runs git with
  the repository's hooks off, so a project's `post-merge` or
  `post-checkout` hook is skipped by the landing. `postLand` is the place for
  what such a hook did.
- **`.claude/rp-worktree.json`** in the main tree, optional, three keys and
  no others: `code` (path prefixes that alone count as code; everything
  else is free), `preLand` and `postLand` (below). A file that does not
  parse is ignored by the guard (every tracked file is code) and refuses the
  landing until it is fixed.

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
