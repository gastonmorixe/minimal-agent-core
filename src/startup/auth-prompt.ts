/**
 * First-time / stale-credentials login prompt for the CLI entry point.
 *
 * Wraps `getAuth()` so a fresh install (no credentials) or a rejected
 * refresh token offers an inline `--login` flow on interactive TTYs
 * instead of dumping the user back at the shell. Non-interactive runs
 * keep the fail-fast behavior.
 *
 * Split out of `src/index.ts` to keep that file under the `max-lines`
 * lint budget.
 *
 * @module startup/auth-prompt
 */

import { c } from "../agent/ansi.ts"
import { getAuth } from "../auth.ts"
import { runLoginCommand } from "../commands/login.ts"

/**
 * Wrap `getAuth()` with a first-time / stale-credentials login prompt.
 *
 * On a fresh install minimal-agent's own store (`~/.minimal-agent/auth.jsonc`)
 * is empty; `getAuth()` throws `"No minimal-agent credentials found …"`.
 * Rather than dump the user back at the shell with an error, we detect that
 * case in interactive mode (TTY on stdout AND stdin) and offer to run
 * `--login` inline. If they accept, we run the OAuth flow and retry
 * `getAuth()`.
 *
 * Non-interactive runs (non-TTY, `--prompt`, piped stdin) keep the current
 * "fail fast with a hint" behavior — script-friendly and predictable.
 *
 * Stale credentials (refresh token rejected) take a similar path: we surface
 * the error and ask if they want to re-login. `getAuth()` itself doesn't
 * eagerly refresh unless the token is within `EXPIRY_BUFFER_MS` of expiry,
 * so this branch only fires when we're about to make a real API call AND
 * the cached token won't survive it. The 401-after-refresh case in
 * `client.ts` is handled separately (it bubbles a clean error that already
 * mentions `--login`).
 */
export async function getAuthWithFirstTimePrompt(): Promise<Awaited<ReturnType<typeof getAuth>>> {
  try {
    return await getAuth()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const looksLikeMissing =
      /No minimal-agent credentials|No credentials found|No OAuth access token|No refresh token/i.test(
        msg,
      )
    const looksLikeStale = /invalid_grant|stale/i.test(msg)
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true

    if (!interactive || (!looksLikeMissing && !looksLikeStale)) {
      throw err
    }

    // Interactive — offer a one-shot login. Print the diagnosis first so
    // the user sees WHY the prompt appeared, then ask y/N. Default is
    // "no" for stale credentials (user might prefer to re-run with
    // different flags) and "yes" for fresh installs (the only sane next
    // step).
    const headline = looksLikeMissing
      ? `${c.bold("Welcome to minimal-agent")} — you're not signed in yet.`
      : `${c.bold("Credentials expired")} — refresh token rejected.`
    console.error("")
    console.error(`  ${c.bold(c.pink("⮕"))} ${headline}`)
    console.error(`  ${c.faintWhite("│")} ${c.dim(msg)}`)
    const defaultYes = looksLikeMissing
    const promptText = `  ${c.faintWhite("│")} Sign in now? ${c.dim(defaultYes ? "[Y/n]" : "[y/N]")} `
    const answer = await readSingleLineFromStdin(promptText)
    const yes = answer === "" ? defaultYes : /^y(es)?$/i.test(answer.trim())
    if (!yes) {
      console.error(
        `  ${c.faintWhite("╰")} ${c.dim("aborted — run `minimal-agent --login` later to sign in.")}`,
      )
      throw err
    }
    console.error(`  ${c.faintWhite("╰")} ${c.dim("starting login…")}`)
    console.error("")

    const code = await runLoginCommand()
    if (code !== 0) {
      // Preserve the original error as `cause` so callers (or a future
      // structured-logging hook) can surface BOTH the post-login retry
      // failure AND the original "no creds / invalid_grant" diagnosis.
      throw new Error(
        "Login failed; see messages above. Re-run `minimal-agent --login` to retry.",
        { cause: err },
      )
    }
    // Login wrote the keychain; retry. If THIS still fails, surface
    // the error — we're not going to loop.
    return await getAuth()
  }
}

/**
 * Read one line from stdin without entering raw mode. Used for the
 * first-time-login y/N prompt. Implementation is the same shape as
 * `commands/login.ts`'s `readLine` but inlined so we don't pull in the
 * full login command module before we know it's needed.
 */
async function readSingleLineFromStdin(promptText: string): Promise<string> {
  const { createInterface } = await import("node:readline")
  return new Promise<string>((resolve) => {
    process.stderr.write(promptText)
    const rl = createInterface({ input: process.stdin, terminal: false })
    // Resolve BEFORE closing + a `settled` guard: `rl.close()` emits
    // `'close'` synchronously, so `resolve(line)` after `rl.close()` would
    // lose the race to the close handler's `resolve("")`. Mirrors the fix in
    // commands/login.ts's `readLine` and src/input.ts's `readFallback`.
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
