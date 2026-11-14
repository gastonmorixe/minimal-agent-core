/**
 * Registry of child processes and process groups that core spawns, so
 * that they die when the host process exits.
 *
 * Why: the Bash tool and the plugin subprocess runner spawn with
 * `detached: true`. On POSIX, Bun then calls `setsid()`, so the child is
 * the leader of a new session and process group
 * (https://bun.com/reference/bun/Spawn/SpawnOptions/detached). A terminal
 * close sends SIGHUP to the foreground group only, and Bun kills no child
 * on exit. Without this registry, a command in flight (or a `cmd &` child
 * that it left) outlives the CLI as an orphan.
 *
 * How: each spawn site calls {@link registerChild}. On the first register,
 * the registry installs ONE `process.on("exit")` listener. That listener
 * is synchronous (an `exit` listener cannot await) and sends SIGKILL to
 * `-pgid` for each group and to `pid` for each single child.
 *
 * Coverage: the `exit` event fires on `process.exit()` and when the event
 * loop has no more work (https://nodejs.org/api/process.html#event-exit).
 * It does NOT fire when the process dies by a signal that has no listener
 * (the default action ends the process), and never on SIGKILL. So a signal
 * is covered only where a listener calls `process.exit(128 + n)`, for
 * example the CLI input and editor hooks. A SIGHUP in a mode with no such
 * listener, or a SIGKILL of the host, leaves the registered groups alive.
 *
 * Bounds: a group entry stays after its leader exits, because background
 * children stay in that group. Each register prunes the group entries
 * whose group is gone (`kill(-pgid, 0)` fails). The group spawn sites call
 * {@link ChildRegistry.releaseIfGone} after the leader exits, so a command
 * with no background child leaves no stale entry whose pgid could be
 * reused before host exit.
 *
 * Behavior change (intended): a user command `nohup x &` in the Bash tool
 * now dies when the CLI exits. A command that must outlive the CLI must
 * call `setsid` itself, which gives it a new process group.
 *
 * @module infra/child-registry
 */

/** Signal for {@link ChildRegistry.killAll}. `0` is a liveness probe only. */
export type ChildSignal = NodeJS.Signals | 0

/** Injected OS ports, so unit tests use fakes. */
export interface ChildRegistryDeps {
  /** Same contract as `process.kill`: a negative pid names a process group. */
  kill: (pid: number, signal: ChildSignal) => void
  /** Same contract as `process.on("exit", fn)`. */
  onExit: (listener: () => void) => void
}

/** Options of {@link ChildRegistry.register}. */
export interface RegisterOptions {
  /** True when `pid` is the leader of its own process group (`detached: true`). */
  group: boolean
}

/** A set of spawned children that one exit listener kills. */
export interface ChildRegistry {
  /** Track `pid`. Returns a function that stops the tracking. */
  register: (pid: number, opts: RegisterOptions) => () => void
  /** Drop the entry for `pid` when its group (or the pid) is gone. Returns true when dropped. */
  releaseIfGone: (pid: number) => boolean
  /** Drop every entry whose group (or pid) is gone. */
  prune: () => void
  /** Send `signal` to every entry. Ignores errors (ESRCH and others). */
  killAll: (signal?: NodeJS.Signals) => void
  /** Snapshot of the tracked pids, for tests and diagnostics. */
  pids: () => number[]
}

const defaultDeps: ChildRegistryDeps = {
  kill: (pid, signal) => {
    process.kill(pid, signal)
  },
  onExit: (listener) => {
    process.on("exit", listener)
  },
}

/** True when the error is "no such process". */
function isEsrch(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "ESRCH"
}

/**
 * Make a registry over the given OS ports. Production code uses the
 * module singleton through {@link registerChild}.
 */
export function createChildRegistry(deps: ChildRegistryDeps = defaultDeps): ChildRegistry {
  // pid -> true when the pid is a process group leader.
  const entries = new Map<number, boolean>()
  let listenerInstalled = false

  const target = (pid: number, group: boolean): number => (group ? -pid : pid)

  const alive = (pid: number, group: boolean): boolean => {
    try {
      deps.kill(target(pid, group), 0)
      return true
    } catch {
      // ESRCH: gone. EPERM: a reused id that we cannot signal, so not ours.
      return false
    }
  }

  const prune = (): void => {
    for (const [pid, group] of entries) {
      if (!alive(pid, group)) entries.delete(pid)
    }
  }

  const killAll = (signal: NodeJS.Signals = "SIGKILL"): void => {
    for (const [pid, group] of entries) {
      try {
        deps.kill(target(pid, group), signal)
      } catch (e) {
        // Fall back to the single pid only when the group call failed for
        // a reason other than "group is gone".
        if (group && !isEsrch(e)) {
          try {
            deps.kill(pid, signal)
          } catch {
            /* already gone */
          }
        }
      }
    }
    entries.clear()
  }

  const register = (pid: number, opts: RegisterOptions): (() => void) => {
    // pid 1 as a group would make the exit listener call kill(-1), which
    // signals every process the user owns (POSIX kill). Our own pid would
    // kill this process or its group. Neither is a child.
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return () => {}
    prune()
    entries.set(pid, opts.group)
    if (!listenerInstalled) {
      listenerInstalled = true
      deps.onExit(() => killAll("SIGKILL"))
    }
    return () => {
      entries.delete(pid)
    }
  }

  const releaseIfGone = (pid: number): boolean => {
    const group = entries.get(pid)
    if (group === undefined) return false
    if (alive(pid, group)) return false
    entries.delete(pid)
    return true
  }

  return { register, releaseIfGone, prune, killAll, pids: () => [...entries.keys()] }
}

/** Process-wide registry. Its exit listener is installed on the first register. */
export const childRegistry: ChildRegistry = createChildRegistry()

/** Register `pid` in the process-wide {@link childRegistry}. */
export function registerChild(pid: number, opts: RegisterOptions): () => void {
  return childRegistry.register(pid, opts)
}
