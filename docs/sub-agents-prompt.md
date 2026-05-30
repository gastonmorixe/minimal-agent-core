# Orchestrating sub-agents (a reusable manager prompt + playbook)

This is a battle-tested recipe for having one agent act as a **manager** that
delegates work to **sub-agents** (separate `minimal-agent` processes), then
reviews, gates, and integrates their work. Paste the prompt block below into any
capable agent to put it in manager mode. The rest of the doc is the playbook the
prompt refers to: the rules, the concrete mechanics, and the templates.

The core idea: **the manager never writes feature code.** It plans, spawns,
monitors, reviews diffs, runs the gate, and commits. Sub-agents do the actual
edits, each on a **disjoint set of files** so they cannot clobber each other.

---

## 1. The manager prompt (copy-paste)

> You are the **manager** of a small team of sub-agents. You will NOT write the
> feature code yourself. Your job: turn the backlog into independent work units,
> spawn one sub-agent per unit (each a separate non-interactive `minimal-agent`
> process), let them work, then review, gate, and integrate their output. You are
> the sole owner of git and of the quality gate.
>
> Follow this loop:
>
> 1. **Plan.** Read the backlog/handoff. Split it into work units that touch
>    **disjoint file sets** (no two units edit the same file). Anything that must
>    touch a shared file gets serialized into a later wave, not parallelized.
>    Defer low-value or high-risk units and say why. Quality over quantity: do not
>    spawn make-work agents.
> 2. **Set up a workspace** under a scratch dir (e.g. `private/work/<epic>/manager/`):
>    a shared `BRIEF.md` (the rules every sub-agent obeys), one `task-<id>.md` per
>    unit (goal + exact file allowlist + validation command + report path), a
>    `reports/` dir, a `logs/` dir, and a `MANAGER-LOG.md`.
> 3. **Validate the spawn mechanism once** with a cheap throwaway probe before
>    spending real budget (see §3).
> 4. **Spawn a wave** of sub-agents (a small number, genuinely independent). Each
>    runs detached with output to a log; record the PIDs.
> 5. **Enter a monitor loop.** Sleep, then poll: are the PIDs alive, are the logs
>    progressing, did the report files appear, what does `git status` show. Do NOT
>    edit source while sub-agents run. Repeat until the wave finishes.
> 6. **Review, do not trust.** Read each report AND the actual `git diff`. Confirm
>    each sub-agent stayed inside its allowlist (no out-of-scope files touched).
> 7. **Gate.** Run the FULL project gate yourself (typecheck + lint + full tests).
>    Sub-agents only ran targeted tests, so cross-unit effects are unverified until
>    now.
> 8. **Integrate.** Commit with **explicit file paths only** (never `git add -A`).
>    Before each commit, verify the staged set against a forbidden-file list.
> 9. **Repeat** for the next wave, building on the now-committed base. Keep
>    `MANAGER-LOG.md` current. When done, write a short final report: what shipped,
>    what's still deferred and why, and any decisions you need from the human.
>
> Hard rules: sub-agents never run git and never run the full gate (only targeted
> tests); they edit only their allowlisted files and write a structured report.
> The manager owns all git and all gating.

Adapt the scratch-dir path, the gate command, and the spawn command to the repo.

---

## 2. Why these rules (the reasoning, so you can adapt them)

- **Disjoint file sets.** Multiple agents in one working tree will overwrite each
  other's edits to a shared file. There is no merge; last write wins. Partitioning
  by file is the cheapest reliable isolation. If two units genuinely need the same
  file, run them in different waves.
- **Sub-agents don't run the full gate.** A whole-project typecheck/test run
  compiles every file, including a peer's half-written edit, and fails for reasons
  that aren't the sub-agent's fault. Targeted `test <their files>` compiles only
  the imported graph, so it isolates the unit. The manager runs the full gate once,
  after the wave, to catch real cross-unit effects.
- **Manager owns git.** Staging is constraint-sensitive (there may be unrelated
  dirty work in the tree that must not be committed). One serialized committer with
  explicit-path staging avoids both races and accidental inclusion. `git add -A` is
  banned for the same reason.
- **Review the diff, not the report.** Reports are a summary written by the thing
  you're checking. Read the actual change. Confirm the allowlist held.
- **Bound concurrency.** Each sub-agent costs real tokens and time and adds tree
  churn. A small wave of genuinely-independent units is easier to review and safer
  than a swarm.

---

## 3. Concrete mechanics for `minimal-agent`

### Spawn one sub-agent (non-interactive, detached)

```bash
# IMPORTANT: --mode none. Non-interactive (--prompt) defaults to ASK mode, which
# is READ-ONLY and will refuse Edit/Write. --mode none gives an unrestricted agent.
# --no-header keeps the log clean.
nohup minimal-agent \
  --model="claude-opus-4-8[1m]" --effort=xhigh \
  --mode none --no-header \
  --prompt "$(cat task-SA1.prompt)" \
  > logs/SA1.log 2>&1 < /dev/null &
echo "SA1_PID=$!" >> pids.txt
```

- **Do NOT use `setsid`** on macOS, it does not exist there and the spawn fails
  silently into the log (`nohup: setsid: No such file or directory`). Plain
  `nohup ... &` is enough; `$!` is then the real PID. Always re-check the PID is
  alive a few seconds after spawning.
- The prompt itself should be tiny: tell the sub-agent to **read `BRIEF.md` then
  `task-<id>.md` in full**, execute strictly within the task, and write its report.
  Keep the detailed instructions in the files (the agent reads them with its tools),
  not crammed into one giant `--prompt` string.
- **Validate the mechanism cheaply first**: spawn one run on a fast/cheap model
  that just writes a sentinel file and exits, and confirm the file appears. This
  catches flag/quoting/detachment problems before you spend real budget.

### Monitor loop (the "sleep mode")

```bash
source pids.txt
sleep 120   # poll cadence; tasks take minutes
for n in SA1 SA2; do
  pid=$(eval echo \$${n}_PID)
  ps -p "$pid" >/dev/null 2>&1 && echo "$n alive ($(ps -o etime= -p $pid))" || echo "$n exited"
done
ls reports/ 2>/dev/null            # reports appear when a unit finishes
git status --short                 # which files changed
sed -e 's/\x1b\[[0-9;]*m//g' logs/SA1.log | tail -8   # what it's doing now (strip ANSI)
```

Poll, do not babysit. Strip ANSI from logs before reading. The report file
appearing is the "done" signal; corroborate with the PID having exited.

### Integrate (manager only)

```bash
# Run the FULL gate first (example commands; use the repo's real gate):
typecheck && lint && full-test-suite

# Stage EXPLICIT paths only, then verify before committing:
git add path/to/file-a path/to/file-b
git diff --cached --name-only                      # eyeball the exact set
git diff --cached --name-only | grep -E '<forbidden-pattern>' && echo ABORT || true
git commit -m "..."                                # atomic, one logical unit
```

Never `git add -A`/`-a`. If the tree has unrelated dirty work, keep a
forbidden-file pattern and grep the staged set against it before every commit.

---

## 4. Templates

### `BRIEF.md` (shared by all sub-agents)

```
# Sub-agent BRIEF — READ FULLY FIRST
You are a sub-agent under a manager on <repo> (<branch>, <runtime>). You were given
ONE task file. Read this, then that file, then execute. Stay inside the task's
file allowlist.

Discipline (mandatory):
1. Edit ONLY the files your task lists. Touch nothing else. No drive-by fixes.
2. Do NOT run git (no add/commit/restore/stash). The manager owns git.
3. Do NOT run the full gate. Validate with the targeted command in your task.
4. Do NOT spawn your own sub-agents or background processes.
5. If a file is locked or holds a peer's half-written code, don't work around it
   destructively, note it in your report and continue with what you can.

Context: <2-6 bullets the units need: key modules, the abstraction they extend,
where things live>.

HARD CONSTRAINTS: <files/areas nobody may touch; invariants that must stay green,
e.g. byte-exact fixtures, public contracts>.

Definition of done: code compiles + your targeted tests pass; report written to the
exact path in your task; no git, no full gate, no out-of-scope edits.
```

### `task-<id>.md` (one per unit)

```
# Task <id> — <one-line goal>
## Goal: <what + why, concrete>
## Background: <the 3-8 facts needed; point at files to read>
## What to build: <numbered, specific steps>
## Files you may edit (ONLY these): <explicit list>  — touch nothing else.
## Keep green (don't break): <existing tests/invariants>
## Validate (targeted only, no git, no full gate): `<the exact test command>`
## Report: write `<reports/ID-REPORT.md>` using this template:
  status: DONE | BLOCKED | PARTIAL
  files changed: <one line each>
  tests run: <commands> -> <pass/fail counts>
  decisions / surprises: <bullets>
  manager must know: <integration notes: new exports, refactors, assumptions>
```

---

## 5. Failure modes actually hit (and the fix)

- **`setsid: No such file or directory`** on macOS, the whole spawn no-ops. Use
  plain `nohup ... &`; capture `$!`; re-check the PID is alive.
- **Sub-agent can't edit anything.** You forgot `--mode none`; non-interactive
  defaults to read-only ASK mode. Add it.
- **A sub-agent's "test failure" is actually a peer's in-flight code.** That's why
  sub-agents run targeted tests only and the manager runs the full gate after the
  wave, on a momentarily-quiet tree.
- **Uncommitted foundation vs. git worktrees.** True isolation wants a worktree per
  sub-agent, but a fresh worktree only sees *committed* state. If your foundation
  is uncommitted, you can't use worktrees, use the same worktree + disjoint files,
  and have the manager re-gate at integration. If the foundation is committed,
  prefer one `git worktree` per sub-agent.
- **Shared tree with other live agents.** Before committing, confirm no other
  process is mid-write (check recent file mtimes), and stage explicit paths so you
  never sweep up someone else's work.
- **Entangled files.** When one file carries two efforts' changes, you cannot split
  it by file-level staging. Either commit it whole (if both belong to your epic) or
  leave it uncommitted and flag it, do not `git add -p` blindly under time pressure.

---

## 6. One-screen checklist

- [ ] Backlog split into disjoint-file units; risky/low-value ones deferred with a reason.
- [ ] Workspace: `BRIEF.md`, `task-*.md`, `reports/`, `logs/`, `MANAGER-LOG.md`.
- [ ] Spawn mechanism validated with a cheap probe.
- [ ] Sub-agents spawned `--mode none`, detached, PIDs recorded, confirmed alive.
- [ ] Monitor loop running; manager not editing source meanwhile.
- [ ] Each finished unit: report read AND diff reviewed; allowlist held.
- [ ] FULL gate green after the wave.
- [ ] Committed with explicit paths; staged set checked against the forbidden list.
- [ ] `MANAGER-LOG.md` + final report updated: shipped / deferred / decisions needed.
```
