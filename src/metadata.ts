/**
 * Metadata module: user_id construction matching CLI v2.1.87 exactly.
 *
 * The Messages API requires a `metadata.user_id` field. In v2.1.87, this
 * changed from a flat string format to a JSON-stringified object.
 *
 * Old format (v2.1.29): "user_<64hex>_account_<uuid>_session_<uuid>"
 * New format (v2.1.87): JSON.stringify({ device_id, account_uuid, session_id })
 *
 * The construction happens in `R76()` (cli.pretty.js L777546-777569):
 *
 *     function R76() {
 *       let q = {};                        // from CLAUDE_CODE_EXTRA_METADATA env
 *       // ... parse env var into q ...
 *       return {
 *         user_id: p6({                    // p6 = JSON.stringify (L9198-9209)
 *           ...q,                          // extra metadata spread FIRST
 *           device_id: dR(),               // OVERRIDES any q.device_id
 *           account_uuid: y_()?.accountUuid ?? "",
 *           session_id: k8(),              // OVERRIDES any q.session_id
 *         }),
 *       };
 *     }
 *
 * The spread order matters: `...q` is spread before the core fields, so
 * CLAUDE_CODE_EXTRA_METADATA can add custom keys but CANNOT override
 * device_id, account_uuid, or session_id.
 *
 * p6() at L9198 is just JSON.stringify called with (object, undefined, undefined),
 * producing compact JSON with no whitespace.
 *
 * Verified against captured traffic. A real request body contains, e.g.:
 *   "user_id":"{\"device_id\":\"<64-hex>\",\"account_uuid\":\"<uuid>\",\"session_id\":\"<uuid>\"}"
 */

import { randomBytes, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AuthResult } from "./auth.ts"

// ---------------------------------------------------------------------------
// Session id (one per process)
// ---------------------------------------------------------------------------

/**
 * Session ID: a random UUID v4 generated once per process.
 *
 * Matches `k8()` at L2248 which returns `f8.sessionId`.
 * The session ID is created by `Bc8()` (which is `randomUUID()` from
 * node:crypto, assigned at L1881) and remains stable for the lifetime
 * of the CLI process. It changes when the user starts a new session
 * (via `Uc8()` at L2251).
 *
 * This same value appears in:
 *   - metadata.user_id → session_id field
 *   - HTTP header: x-claude-code-session-id (L238036)
 */
let cachedSessionId: string | null = null

export function getSessionId(): string {
  if (!cachedSessionId) {
    cachedSessionId = randomUUID()
  }
  return cachedSessionId
}

/** Reset for testing — allows tests to get a fresh session ID */
export function _resetSessionId(): void {
  cachedSessionId = null
}

// ---------------------------------------------------------------------------
// Device id (persistent, read from CLI config)
// ---------------------------------------------------------------------------

/**
 * Default path to the CLI's config file.
 *
 * Resolved by `aM()` at L45457-45462:
 *   - If ~/.claude/.config.json exists, use that
 *   - Otherwise: `~/.claude${k61()}.json` (k61 returns "" for standard installs)
 *   - Respects CLAUDE_CONFIG_DIR env override
 *
 * For standard installs this is simply `~/.claude.json`.
 */
const DEFAULT_CONFIG_PATH = join(process.env.HOME ?? "", ".claude.json")

/**
 * Get the device ID (a persistent 64-hex-char string).
 *
 * The CLI generates this in `dR()` at L48036-48047:
 *
 *     function dR() {
 *       let q = j8();              // read config
 *       if (q.userID) return q.userID;  // return cached
 *       let K = GP5(32).toString("hex"); // GP5 = randomBytes (L47426)
 *       x8(_ => ({..._, userID: K}));    // persist to config
 *       return K;
 *     }
 *
 * So `userID` in ~/.claude.json IS the device_id. It's 32 random bytes
 * encoded as hex = 64 characters, generated once and persisted forever.
 *
 * We read it from the real CLI config so our user_id matches exactly.
 * If ~/.claude.json doesn't exist (e.g. CLI not installed), we fall back
 * to generating and persisting our own in ~/.claude-demo/state.json.
 *
 * Verified: ~/.claude.json contains a `userID` field like:
 *   { "userID": "<64 hex chars>" }
 * which matches the device_id in captured .node-net-dbg requests.
 */
export function getDeviceId(configPath: string = DEFAULT_CONFIG_PATH): string {
  // Try reading from the real CLI config first
  try {
    const raw = readFileSync(configPath, "utf-8")
    const config = JSON.parse(raw) as { userID?: string }
    if (config.userID && config.userID.length === 64) {
      return config.userID
    }
  } catch {
    // Config doesn't exist or is invalid — fall through to our own state
  }

  // Fallback: generate and persist to our own state file.
  // This path is only hit if the Claude Code CLI has never been installed.
  const stateDir = join(process.env.HOME ?? "", ".claude-demo")
  const statePath = join(stateDir, "state.json")

  try {
    const raw = readFileSync(statePath, "utf-8")
    const state = JSON.parse(raw) as { deviceId?: string }
    if (state.deviceId && state.deviceId.length === 64) {
      return state.deviceId
    }
  } catch {
    // no state file — generate below
  }

  // Generate like the CLI does: randomBytes(32).toString("hex")
  const id = randomBytes(32).toString("hex")
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(statePath, JSON.stringify({ deviceId: id }, null, 2))
  } catch {
    // best effort persistence
  }
  return id
}

// ---------------------------------------------------------------------------
// Extra metadata from env
// ---------------------------------------------------------------------------

/**
 * Load optional extra metadata from the CLAUDE_CODE_EXTRA_METADATA env var.
 *
 * In R76() (L777548-777559), the CLI parses this env var as JSON and spreads
 * it into the user_id object. It must be a JSON object (not array or primitive).
 * If invalid, the CLI logs an error and ignores it. We do the same.
 *
 * The spread happens BEFORE the core fields, so extra metadata cannot
 * override device_id, account_uuid, or session_id.
 */
export function loadExtraMetadata(): Record<string, unknown> {
  const raw = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {
    // invalid JSON — ignore silently (CLI logs an error, we skip it)
  }
  return {}
}

// ---------------------------------------------------------------------------
// buildUserId — pure function, easy to test
// ---------------------------------------------------------------------------

/**
 * Build the user_id string from its components.
 *
 * This is a pure function that mirrors R76()'s core logic:
 *   JSON.stringify({ ...extra, device_id, account_uuid, session_id })
 *
 * The result is a compact JSON string (no whitespace) because p6() at L9198
 * calls JSON.stringify with no replacer and no space arguments.
 *
 * @example
 *   buildUserId({
 *     deviceId: "<64 hex>",
 *     accountUuid: "<uuid>",
 *     sessionId: "<uuid>",
 *   })
 *   // → '{"device_id":"<64 hex>","account_uuid":"<uuid>","session_id":"<uuid>"}'
 */
export function buildUserId(opts: {
  deviceId: string
  accountUuid: string
  sessionId: string
  extra?: Record<string, unknown>
}): string {
  const payload: Record<string, unknown> = {
    ...opts.extra,
    device_id: opts.deviceId,
    account_uuid: opts.accountUuid,
    session_id: opts.sessionId,
  }
  return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// buildMetadata — orchestrates everything
// ---------------------------------------------------------------------------

/**
 * Build the complete `metadata` payload for a Messages API request.
 *
 * Orchestrates getDeviceId() + getSessionId() + loadExtraMetadata()
 * to produce the same `{ user_id: "..." }` that R76() returns.
 */
export function buildMetadata(auth: AuthResult, configPath?: string): { user_id: string } {
  return {
    user_id: buildUserId({
      deviceId: getDeviceId(configPath),
      accountUuid: auth.type === "oauth" && auth.accountUuid ? auth.accountUuid : "",
      sessionId: getSessionId(),
      extra: loadExtraMetadata(),
    }),
  }
}
