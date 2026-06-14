/**
 * Session-store + blob-store boot for the CLI entry point.
 *
 * Opens (or forks, on `--resume`) the per-session JSONL store, builds
 * the per-session blob store, emits the soft resume warnings (live
 * peer process, system/tools drift), and installs the attach/detach
 * lifecycle markers on the process.
 *
 * Split out of `src/index.ts` to keep that file under the `max-lines`
 * lint budget. All behavior is byte-identical to the previous inline
 * block; only the location changed.
 *
 * @module startup/session-store-boot
 */

import { BlobStore, loadBlobStoreConfig } from "../blob-store.ts"
import { VERSION } from "../headers.ts"
import { loadSession } from "../session-restore.ts"
import { SessionStore } from "../session-store.ts"
import {
  renderLiveSessionWarning,
  renderSessionDriftWarning,
  renderStoreUnavailableWarning,
} from "../ui/chrome/session-store-boot.ts"
import { type CommandOutput, writeCommandRows } from "../ui/command-output.ts"

/** Inputs for {@link bootSessionStores}. */
export interface SessionStoreBootOptions {
  /** This process's session id (the fresh per-process UUID). */
  sid: string
  /** Parent session id when resuming, else `null`. */
  resumeSid: string | null
  /** The resolved model id recorded in the meta record. */
  selectedModel: string
  /** Hash of the system-prompt recipe (resume drift detection). */
  systemHash: string
  /** Hash of the advertised tool set (resume drift detection). */
  toolsHash: string
  /** Warning output stream; tests inject a collector. */
  output?: CommandOutput
}

/** Result of {@link bootSessionStores}. */
export interface SessionStoreBootResult {
  /** The opened/forked session store, or `null` when unavailable. */
  store: SessionStore | null
  /** The blob store, or `null` when disabled/unavailable. */
  blobStore: BlobStore | null
}

/**
 * Open the session store (fork on resume), build the blob store, warn
 * on live-peer / drift resume hazards, and install attach/detach
 * markers. Persistence is best-effort throughout: failures warn and
 * return `null` stores rather than blocking startup.
 */
export async function bootSessionStores(
  opts: SessionStoreBootOptions,
): Promise<SessionStoreBootResult> {
  const { sid, resumeSid, selectedModel, systemHash, toolsHash } = opts
  const output = opts.output ?? process.stderr

  // Open the session store. Two paths:
  //   - new session: SessionStore.open(getSessionId())
  //   - resume:      SessionStore.fork({ srcSid: resumeSid, dstSid: getSessionId() })
  //
  // Fork semantics matter: every other subsystem (banner, file log, plugin
  // sessionId, tasks/scratch files, goodbye banner's `--resume <id>` hint)
  // ALREADY uses `getSessionId()` — the fresh per-process UUID. Before this
  // path was wired, the store was the only outlier: it appended to the
  // parent's `<resumeSid>.jsonl` (with existsOk:true), so the goodbye
  // banner's `minimal-agent --resume <new-sid>` pointed to a file that
  // did not exist. Forking copies the parent's records into a new file
  // under the new sid, aligns the store with everything else, and leaves
  // the parent untouched (non-destructive — re-resuming the parent works
  // forever).
  //
  // `SessionStore.fork` ALSO copies per-sid sidecar files (tasks plugin's
  // `<sid>.tasks.jsonl`, memory plugin's `<sid>.scratch.md`, draft store's
  // `<sid>.draft`, …) from `srcSid` to `dstSid`. Without this, sidecar
  // plugins read from an empty file on resume even though the
  // conversation log references their prior state (e.g. the model marks
  // task #6 done but task #6 doesn't exist in the new file). The blob
  // DIRECTORY is the one exception — tool results carry absolute paths
  // into the parent's `<srcSid>.blobs/`, so blobs survive resume by
  // reference without duplication.
  //
  // Resume drift check emits a one-line yellow warning when system/tools
  // have changed since the parent was saved.
  let store: SessionStore | null = null
  try {
    store = resumeSid
      ? SessionStore.fork({
          srcSid: resumeSid,
          dstSid: sid,
          model: selectedModel,
          cwd: process.cwd(),
          systemHash,
          toolsHash,
          agentVersion: VERSION,
          argv: process.argv,
        })
      : SessionStore.open({
          sid,
          model: selectedModel,
          cwd: process.cwd(),
          systemHash,
          toolsHash,
          agentVersion: VERSION,
          argv: process.argv,
        })
  } catch (err) {
    // Persistence is best-effort; never block startup on it. The agent
    // will work without a store (just no resume for THIS session).
    writeCommandRows(
      renderStoreUnavailableWarning("session", err instanceof Error ? err.message : String(err)),
      output,
    )
  }

  // Per-session blob store for raw tool outputs. Lives at
  // `~/.minimal-agent/sessions/<sid>.blobs/`, populated lazily as tools
  // emit large or truncated bodies. Best-effort like the session store:
  // a missing or disabled blob store means tool results still flow,
  // just without the `<ma::agent::raw-output …/>` footer pointer. The config gates
  // (enabled, minBytesToPersist, max caps, skipTools, env opt-out) are
  // resolved here and frozen for the session.
  let blobStore: BlobStore | null = null
  try {
    const { config: blobConfig } = loadBlobStoreConfig()
    if (blobConfig.enabled) {
      blobStore = new BlobStore({
        sid,
        config: blobConfig,
      })
    }
  } catch (err) {
    writeCommandRows(
      renderStoreUnavailableWarning("blob", err instanceof Error ? err.message : String(err)),
      output,
    )
  }

  // Soft warn-on-resume: if another agent process appears to be live on
  // this same session, the user is about to fork the conversation.
  // Liveness is OS-probed (kill(0) + ps -o lstart=) so this catches the
  // common cases (running, dead, pid-reused) without relying on clean
  // detach markers. See `src/session-liveness.ts`.
  if (resumeSid) {
    try {
      const { getSessionLiveness } = await import("../session-liveness.ts")
      const live = getSessionLiveness(resumeSid)
      if (live.status === "live" && live.pid !== process.pid) {
        writeCommandRows(
          renderLiveSessionWarning({ sid: resumeSid, pid: live.pid, since: live.since }),
          output,
        )
      }
    } catch {
      // best-effort; never block resume on liveness probing
    }

    try {
      const loaded = loadSession(resumeSid)
      const drifted =
        loaded.meta &&
        (loaded.meta.systemHash !== systemHash || loaded.meta.toolsHash !== toolsHash)
      if (drifted) {
        writeCommandRows(renderSessionDriftWarning(), output)
      }
    } catch {
      // already reported above
    }
  }

  // Mark this process as the current owner of the session (new OR resume).
  // Liveness is OS-probed by readers; the AttachRecord is just the pointer
  // they walk. The matching DetachRecord is best-effort and missing it is
  // explicitly fine — readers verify against the live OS, not the log.
  if (store) {
    const liveStore = store
    try {
      liveStore.appendAttach()
    } catch {
      // best-effort
    }
    let detachWritten = false
    const writeDetach = (reason: "exit" | "signal" | "error", code?: number) => {
      if (detachWritten) return
      detachWritten = true
      // Skip cleanup on the error paths — a SIGINT/uncaughtException
      // mid-turn may have committed nothing yet but the user still wants
      // an audit trail (and the on-disk meta can be useful for debugging
      // a crash). Only the clean "exit" path with no recorded
      // conversation is eligible for the session to vanish.
      if (reason === "exit") {
        try {
          if (liveStore.cleanupIfUnused()) return
        } catch {
          // best-effort; fall through and write the detach marker
        }
      }
      try {
        liveStore.appendDetach(reason, code)
      } catch {
        // swallow — we may already be inside process.exit
      }
    }
    // The editor-controller's signal handlers call process.exit(), which
    // fires the 'exit' event and runs this handler. So a single 'exit'
    // hook covers SIGINT/SIGTERM/SIGHUP plus clean exits. Fatal handlers
    // only record the detach marker, then rethrow so the runtime still
    // terminates instead of continuing in a corrupted state.
    process.on("exit", (code) => writeDetach("exit", typeof code === "number" ? code : 0))
    process.on("uncaughtException", (err) => {
      writeDetach("error")
      throw err
    })
    process.on("unhandledRejection", (reason) => {
      writeDetach("error")
      throw reason
    })
  }

  return { store, blobStore }
}
