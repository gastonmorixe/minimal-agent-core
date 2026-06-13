/**
 * `/config` command — open the interactive config editor overlay.
 *
 *   /config            → open the overlay (browse + edit knobs live)
 *   /config get <id>   → print one field's current value (no overlay)
 *   /config path       → print the resolved config file path
 *
 * The overlay is painted into the editor's footer band (`editor.footer.set`)
 * and driven by the `editor.key` + `editor.buffer.changed` handlers, exactly
 * like the slash-menu. This command's job is to BUILD the model (static
 * schema + discovered-plugin toggles), seed the singleton FSM state, paint
 * the first frame, then return `none` so the REPL prints nothing and the
 * overlay owns the screen until the user closes it.
 *
 * Decoupling: the command never imports another plugin or touches the queue
 * / editor directly. It paints + primes the buffer purely by emitting on the
 * shared bus (shape-aware `ctx.emit`), and reads the command registry only
 * through the host (it doesn't here, but could via a future ctx hook).
 *
 * @module config/handlers/cmd_config
 */

import type { CommandContext, CommandResult } from "@minimal-agent/plugin-api/types/plugin"

import { discoverPlugins, pluginFields } from "../lib/discovery.ts"
import { transition } from "../lib/fsm.ts"
import { ConfigModel } from "../lib/model.ts"
import { type ApplyDeps, applyEffects } from "../lib/runtime.ts"
import { fieldById, SCHEMA } from "../lib/schema.ts"
import { CONFIG_OVERLAY_OWNER, getState, setModel, setState } from "../lib/state.ts"
import { effectiveValue } from "../lib/view.ts"

import { discoveryRoots, realDiscoverDeps, realFsDeps, resolveConfigPath } from "./wiring.ts"

const MAX_ROWS = 9

/**
 * Entry point for the `/config` command. With arguments it runs the headless
 * sub-commands (get/set/path) and returns text; with no arguments it builds
 * the config model (static schema plus one toggle per discovered plugin) and
 * opens the interactive overlay via the editor-overlay channels.
 */
export default function cmdConfig(ctx: CommandContext): CommandResult {
  const path = resolveConfigPath(ctx.env)

  // Sub-commands that DON'T open the overlay (headless-friendly).
  const argv = ctx.argv.trim()
  if (argv.length > 0) {
    const headless = handleHeadless(argv, path)
    if (headless) return headless
  }

  // Build the model: static schema + a toggle per discovered plugin.
  const roots = discoveryRoots(packageDir(), ctx.cwd, ctx.env)
  const plugins = discoverPlugins(realDiscoverDeps(roots))
  const fields = [...SCHEMA, ...pluginFields(plugins)]
  const model = ConfigModel.load(realFsDeps(path), { fields })
  setModel(model)

  // Take MODAL ownership of the input line FIRST: the host hides the prompt
  // row + cursor, blocks submit (so the typed `/config` can't leak to
  // scrollback), and routes every key — including printables + Backspace —
  // through `editor.key` so the overlay drives its own draft. This is the fix
  // for the prompt-and-overlay-share-one-buffer bugs.
  ctx.emit("editor.overlay.open", { owner: CONFIG_OVERLAY_OWNER })

  // Open the FSM and paint the first frame.
  const cols = terminalCols()
  const { state, effects } = transition(getState(), { kind: "open" }, { rows: [] })
  setState(state)
  const deps: ApplyDeps = {
    emit: ctx.emit,
    cols,
    maxRows: MAX_ROWS,
    getState,
    model,
  }
  applyEffects(effects, deps)

  // The overlay now owns the input line + footer + keys. Nothing to print, no
  // model turn.
  return { kind: "none" }
}

/**
 * Handle the non-interactive sub-commands. Returns a CommandResult to short
 * -circuit, or `null` to fall through and open the overlay.
 */
function handleHeadless(argv: string, path: string): CommandResult | null {
  const [verb, ...rest] = argv.split(/\s+/)
  if (verb === "path") {
    return { kind: "notice", lines: [path] }
  }
  if (verb === "get") {
    const id = rest[0]
    if (!id) return { kind: "error", message: "usage: /config get <field-id>" }
    const field = fieldById(id)
    if (!field) return { kind: "error", message: `unknown field "${id}"` }
    const model = ConfigModel.load(realFsDeps(path), { fields: SCHEMA })
    const v = effectiveValue(model.value(field))
    return {
      kind: "notice",
      lines: [`${id} = ${v === undefined ? "(unset)" : JSON.stringify(v)}`],
    }
  }
  // Unknown sub-command (and not just whitespace) → tell the user, don't
  // silently open. `help` falls here too.
  return {
    kind: "notice",
    lines: [
      "usage: /config            open the interactive editor",
      "       /config get <id>   print a field's current value",
      "       /config path       print the config file path",
    ],
  }
}

/** This plugin's package dir, derived from the handler's module URL. */
function packageDir(): string {
  // handlers/cmd_config.ts → packageDir is one level up from this file's dir.
  return new URL("..", import.meta.url).pathname
}

function terminalCols(): number {
  const c = (process.stdout as unknown as { columns?: number }).columns
  return typeof c === "number" && c > 0 ? c : 100
}
