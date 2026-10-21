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
- Thresholds are constants at the top of `hooks/resource-guard/index.ts`.

Known limits: processes the plugin did not start are only counted, never
capped; the macOS and Windows probes were written without a machine to run
them on; inside the slice `cd` does not carry over to the next command.

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
