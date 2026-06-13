/**
 * `minimal-agent --login` command.
 *
 * Thin CLI wrapper over `../oauth-login.ts`'s `runOAuthLogin`. Handles
 * the I/O surfaces the orchestrator delegates: reading the pasted code from
 * stdin (with `readline`, supports both interactive TTY and piped stdin),
 * opening the browser via the macOS / Linux / Windows handlers, and
 * pretty-printing progress / outcome rows.
 *
 * Module is kept I/O-thin so that the orchestrator stays pure-ish and
 * unit-testable. Tests live in `src/oauth-login.test.ts`; this wrapper is
 * exercised end-to-end by `src/commands/login.test.ts`.
 *
 * @module commands/login
 */

import { createInterface } from "node:readline"

import { defaultAuthStore, type SecretBag } from "../auth-store.ts"
import {
  findApiKeyAuthProvider,
  findOAuthLoginProvider,
  listApiKeyAuthProviders,
  listOAuthLoginProviderEntries,
} from "../auth-strategies.ts"
import type { ApiKeyAuthProvider, OAuthLoginProvider } from "../llm/provider-plugin.ts"
import { type LoginInstallResult, type LoginOutcome, runOAuthLogin } from "../oauth-login.ts"
import { c } from "../ui/style/ansi.ts"

/**
 * Open a URL in the user's default browser. Returns `true` on success,
 * `false` otherwise. Equivalent to the upstream CLI's `openBrowser()`
 * but inlined here so we don't drag in their utility tree.
 */
async function openBrowser(url: string): Promise<boolean> {
  // Validate the URL — never spawn `open` on a value the user might have
  // controlled. The OAuth orchestrator constructs URLs internally, but a
  // future caller might pass arbitrary input.
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  } catch {
    return false
  }

  const platform = process.platform
  const browserEnv = process.env.BROWSER

  let cmd: string
  let args: string[]
  if (platform === "win32") {
    if (browserEnv) {
      cmd = browserEnv
      args = [url]
    } else {
      cmd = "rundll32"
      args = ["url,OpenURL", url]
    }
  } else {
    cmd = browserEnv || (platform === "darwin" ? "open" : "xdg-open")
    args = [url]
  }

  try {
    const proc = Bun.spawnSync([cmd, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    })
    return proc.exitCode === 0
  } catch {
    return false
  }
}

export interface LoginCommandOptions {
  /** Pre-fill email on the login form. */
  loginHint?: string
  /** Provider id whose OAuth login strategy should run. */
  providerId?: string
  /** Auth method to run for the provider. Defaults to OAuth when available, else API key. */
  authMethod?: string
  /** Override the maximum number of paste attempts (default 3). */
  maxAttempts?: number
}

type LoginMethod =
  | { kind: "oauth"; provider: OAuthLoginProvider }
  | { kind: "api-key"; providerId: string; provider: ApiKeyAuthProvider }

function resolveOAuthLoginProvider(providerId: string | undefined): OAuthLoginProvider {
  if (providerId) {
    const provider = findOAuthLoginProvider(providerId)
    if (!provider) throw new Error(`provider "${providerId}" does not support OAuth login`)
    return provider
  }

  const providers = listOAuthLoginProviderEntries()
  if (providers.length === 1) return providers[0].auth
  if (providers.length === 0) throw new Error("No OAuth login provider is registered.")
  throw new Error(
    `multiple OAuth providers are registered; choose one with ` +
      `\`minimal-agent provider <id> login\` (${providers.map((p) => p.providerId).join(", ")})`,
  )
}

function resolveApiKeyLoginProvider(providerId: string | undefined): LoginMethod {
  if (providerId) {
    const provider = findApiKeyAuthProvider(providerId)
    if (!provider) throw new Error(`provider "${providerId}" does not support API-key login`)
    return { kind: "api-key", providerId, provider }
  }

  const providers = listApiKeyAuthProviders()
  if (providers.length === 1) {
    const [entry] = providers
    return { kind: "api-key", providerId: entry.providerId, provider: entry.auth }
  }
  if (providers.length === 0) throw new Error("No API-key login provider is registered.")
  throw new Error(
    `multiple API-key providers are registered; choose one with ` +
      `\`minimal-agent provider <id> login api-key\` (${providers.map((p) => p.providerId).join(", ")})`,
  )
}

function resolveLoginMethod(opts: LoginCommandOptions): LoginMethod {
  const method = opts.authMethod?.trim().toLowerCase()
  if (method && method !== "oauth" && method !== "api-key" && method !== "key") {
    throw new Error(`unknown auth method "${opts.authMethod}" (expected oauth or api-key)`)
  }
  if (method === "api-key" || method === "key") return resolveApiKeyLoginProvider(opts.providerId)
  if (method === "oauth")
    return { kind: "oauth", provider: resolveOAuthLoginProvider(opts.providerId) }

  const oauth = opts.providerId ? findOAuthLoginProvider(opts.providerId) : undefined
  if (oauth) return { kind: "oauth", provider: oauth }
  if (opts.providerId) return resolveApiKeyLoginProvider(opts.providerId)
  return { kind: "oauth", provider: resolveOAuthLoginProvider(undefined) }
}

/**
 * Read one line of pasted input from stdin. We use `readline` (not raw mode)
 * so terminal-level paste / line-editing / Ctrl+C handling all behave
 * exactly the way the user expects from a normal shell prompt.
 *
 * Caveat: on a piped stdin, this reads up to the first newline and returns;
 * EOF before a newline returns whatever was read (or "" for an empty pipe).
 *
 * `input` / `output` are injectable for tests (a `PassThrough` pair drives
 * the line/close ordering deterministically without a real TTY); production
 * defaults to `process.stdin` / `process.stderr`.
 */
export async function readLine(
  promptText: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  return new Promise<string>((resolve) => {
    // Output the prompt + read from stdin via readline. We aim the
    // readline output at stderr to match the rest of our UI rows (the
    // banner, the orchestrator's `display(...)` calls, etc.). stdout is
    // reserved for "real output" — there isn't any here, but the split
    // matters for consistency and for piping (`minimal-agent --login`
    // never writes anything meaningful to stdout, so a redirect like
    // `--login > /tmp/x` shouldn't capture UI noise).
    const rl = createInterface({
      input,
      output,
      // `terminal` describes the INPUT stream (whether to do raw-mode line
      // editing), so it must reflect the input's TTY-ness — NOT stderr's.
      // The old `process.stderr.isTTY` was the wrong stream: harmless when
      // both are the same TTY, but conceptually backwards and a latent bug
      // when they diverge (e.g. stdin a TTY, stderr redirected).
      terminal: input.isTTY ?? false,
    })
    rl.setPrompt(promptText)
    rl.prompt()
    // `settled` + resolve-before-close: `rl.close()` emits `'close'`
    // SYNCHRONOUSLY, so a `resolve(line)` placed *after* `rl.close()` loses
    // the race to the close handler's `resolve("")` — the captured line is
    // silently dropped and the caller sees an empty paste ("no code
    // pasted"). Resolving first and guarding the close path fixes it. Same
    // shape as `readFallback` in src/input.ts.
    let settled = false
    rl.once("line", (line) => {
      settled = true
      resolve(line)
      rl.close()
    })
    rl.once("close", () => {
      if (!settled) resolve("")
    })
  })
}

/** Read a single secret line from a TTY without echoing the bytes. */
export async function readSecretLine(
  promptText: string,
  input: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  output.write(promptText)
  return new Promise<string>((resolve) => {
    let value = ""
    const wasRaw = input.isRaw
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString("utf8")
      for (const ch of text) {
        const code = ch.charCodeAt(0)
        if (ch === "\r" || ch === "\n") {
          cleanup()
          output.write("\n")
          resolve(value)
          return
        }
        if (code === 3) {
          cleanup()
          output.write("\n")
          process.kill(process.pid, "SIGINT")
          return
        }
        if (code === 127 || code === 8) {
          value = value.slice(0, -1)
          continue
        }
        value += ch
      }
    }
    const cleanup = () => {
      input.off("data", onData)
      input.pause()
      if (input.setRawMode && wasRaw !== undefined) input.setRawMode(wasRaw)
    }
    if (input.setRawMode) input.setRawMode(true)
    input.resume()
    input.on("data", onData)
  })
}

/**
 * Print the auth URL with a click-friendly format and the rest of the
 * instructions. We separate `display(...)` calls in `runOAuthLogin` from
 * "what the user actually reads" because the orchestrator's view of
 * "displayed" is one-line-per-call, but the CLI wants a nicer multi-line
 * layout (URL on its own indented line, etc.).
 */
function printBanner(): void {
  process.stderr.write(`  ${c.bold(c.pink("⮕"))} ${c.bold("Sign in")}\n`)
  process.stderr.write(`  ${c.faintWhite("│")}\n`)
}

function printSuccessFooter(result: LoginInstallResult): void {
  const account = result.account
  const acctSuffix = account
    ? ` ${c.dim(`(${account.emailAddress} · ${account.uuid.slice(0, 8)}…)`)}`
    : ""
  process.stderr.write(`\n  ${c.boldGreen("✔")} ${c.bold("Login successful")}${acctSuffix}\n`)
  if (result.scopes.length > 0) {
    process.stderr.write(`  ${c.dim(`scopes: ${result.scopes.join(" ")}`)}\n`)
  }
  const expDate = new Date(result.expiresAt).toISOString().replace("T", " ").slice(0, 19)
  process.stderr.write(`  ${c.dim(`expires: ${expDate} UTC`)}\n`)
}

function printApiKeySuccessFooter(displayName: string): void {
  process.stderr.write(`\n  ${c.boldGreen("✔")} ${c.bold("Login successful")}\n`)
  process.stderr.write(`  ${c.dim(`stored: ${displayName}`)}\n`)
}

function printFailureFooter(reason: string): void {
  process.stderr.write(`\n  ${c.boldRed("✗")} ${c.bold("Login failed")} ${c.dim(`— ${reason}`)}\n`)
}

/**
 * Run the OAuth login flow as a top-level CLI command. Returns an exit code
 * suitable for `process.exit(code)`. The caller is responsible for actually
 * exiting; we deliberately don't `process.exit()` here so tests can spy on
 * the return value.
 *
 * Refuses non-TTY stdin: the manual-paste flow requires the user to open
 * a browser between the URL display and the paste prompt, which is
 * fundamentally interactive. A piped stdin (`</dev/null`,
 * `echo CODE#STATE | --login`) can't satisfy that — the auth code is
 * bound to a fresh PKCE `code_verifier` generated AFTER stdin is fed, so
 * pre-canned input is meaningless. Failing loud here is friendlier than
 * spinning through `maxAttempts` empty reads and exiting 0 by accident
 * (which is what an EOF-on-first-read used to do).
 */
export async function runLoginCommand(opts: LoginCommandOptions = {}): Promise<number> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `  ${c.boldRed("✗")} ${c.bold("--login requires an interactive terminal")} ${c.dim(
        "(stdin must be a TTY; PKCE manual-paste flow can't be scripted)",
      )}\n`,
    )
    return 1
  }
  printBanner()
  let method: LoginMethod
  try {
    method = resolveLoginMethod(opts)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    printFailureFooter(msg)
    return 1
  }

  if (method.kind === "api-key") {
    try {
      const key = await readSecretLine(
        `  ${c.faintWhite("│")} ${c.dim(`${method.provider.displayName} key`)} ${c.bold(c.pink("›"))} `,
      )
      if (key.trim().length === 0) {
        printFailureFooter("empty API key")
        return 1
      }
      const write = method.provider.buildCredential(key.trim())
      defaultAuthStore().set(write.serviceId, write.displayName, write.secrets as SecretBag)
      printApiKeySuccessFooter(write.displayName)
      return 0
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      printFailureFooter(msg)
      return 1
    }
  }

  let outcome: LoginOutcome
  try {
    outcome = await runOAuthLogin({
      provider: method.provider,
      loginHint: opts.loginHint,
      maxAttempts: opts.maxAttempts,
      openUrl: openBrowser,
      display: (msg) => {
        // The orchestrator emits "Opening browser…", "If the browser
        // didn't open, visit:\n  URL", and any "Invalid code" /
        // "State mismatch" follow-ups. Indent + faint-pipe to match the
        // startup tree's visual style.
        const lines = msg.split("\n")
        for (const line of lines) {
          process.stderr.write(`  ${c.faintWhite("│")} ${line}\n`)
        }
      },
      readPaste: async () =>
        readLine(`  ${c.faintWhite("│")} ${c.dim("paste code")} ${c.bold(c.pink("›"))} `),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    printFailureFooter(msg)
    return 1
  }

  if (!outcome.ok) {
    printFailureFooter(outcome.reason)
    return 1
  }
  printSuccessFooter(outcome.result)
  return 0
}
