/**
 * One-shot subcommand dispatch for agent startup.
 *
 * The entry point resolves a {@link CommandPlan} from the CLI flags; when the
 * plan selects anything other than the interactive/one-shot agent run
 * (`"run"`), that subcommand is handled here and the process either returns
 * (list/dump commands) or exits (login/logout/auth-status). Lifted out of
 * `src/index.ts` so the entry point stays a thin composition root.
 *
 * Path safety: `repoRoot` is passed IN (computed by the entry point, which
 * lives at `src/` and can trust `import.meta.dirname`). This module never
 * derives filesystem roots from its own location, so it is immune to being
 * moved deeper in the tree — the module-relative-path class of bug.
 *
 * @module host/startup/run-subcommand
 */

import { resolveAgentHome } from "../../agent/agent-paths.ts"
import type { PrintFormat } from "../../cli/print-format.ts"
import type { CommandPlan } from "../cli/command-plan.ts"
import { runAuthStatusCommand } from "../commands/auth-status.ts"
import { DumpCommandError, runDumpCommand } from "../commands/dump.ts"
import { runListFlagsCommand } from "../commands/list-flags.ts"
import { runListModelsCommand } from "../commands/list-models.ts"
import { runListModelsLiveCommand } from "../commands/list-models-live.ts"
import { runListPluginsCommand } from "../commands/list-plugins.ts"
import { runListProvidersCommand } from "../commands/list-providers.ts"
import { runListSpinnersCommand } from "../commands/list-spinners.ts"
import { runLoginCommand } from "../commands/login.ts"
import { runLogoutCommand } from "../commands/logout.ts"
import { runSessionsCommand } from "../commands/sessions.ts"
import { runUsageCommand } from "../commands/usage.ts"
import { c } from "../ui/style/ansi.ts"

/** Everything the subcommand dispatcher needs from the entry point. */
export interface SubcommandContext {
  readonly commandPlan: CommandPlan
  readonly args: string[]
  readonly dumpArg: string | undefined
  readonly dumpFormatArg: string
  readonly dumpPaths: boolean
  readonly sessionsQuery: string | undefined
  readonly usagePeriod: string | undefined
  readonly listModelsProvider: string | undefined
  readonly printFormat: PrintFormat
  /** Repo root (`<repo>`), computed by the caller — never derived here. */
  readonly repoRoot: string
  /** Inline-or-spaced flag reader from the entry point. */
  readonly readFlagValue: (name: string) => string | undefined
}

/**
 * Run the selected one-shot subcommand, if any.
 *
 * @param ctx - The resolved command plan plus the flags each command reads.
 * @returns `true` when a subcommand handled the run (caller should return);
 *   `false` for the `"run"` case (caller proceeds to the agent run). Login,
 *   logout, and auth-status call `process.exit` and never return.
 */
export async function runStartupSubcommand(ctx: SubcommandContext): Promise<boolean> {
  const { commandPlan, args, readFlagValue } = ctx
  switch (commandPlan.command) {
    case "dump": {
      if (!ctx.dumpArg) {
        console.error(`  ${c.boldRed("error")} --dump requires <sid|last>`)
        process.exit(1)
      }
      try {
        await runDumpCommand({
          target: ctx.dumpArg,
          format: ctx.dumpFormatArg,
          paths: ctx.dumpPaths,
          cwd: process.cwd(),
        })
      } catch (err) {
        if (err instanceof DumpCommandError) {
          console.error(`  ${c.boldRed("error")} ${err.message}`)
          process.exit(1)
        }
        console.error(
          `  ${c.boldRed("error")} could not dump session ${ctx.dumpArg}: ${err instanceof Error ? err.message : String(err)}`,
        )
        process.exit(1)
      }
      return true
    }
    case "sessions":
      runSessionsCommand({ query: ctx.sessionsQuery })
      return true
    case "usage":
      await runUsageCommand({ period: ctx.usagePeriod })
      return true
    case "list-flags":
      runListFlagsCommand()
      return true
    case "list-spinners":
      runListSpinnersCommand()
      return true
    case "list-models":
      await runListModelsCommand(ctx.listModelsProvider, { printFormat: ctx.printFormat })
      return true
    case "list-models-live":
      await runListModelsLiveCommand(ctx.listModelsProvider)
      return true
    case "list-providers":
      runListProvidersCommand()
      return true
    case "list-plugins":
      runListPluginsCommand({
        roots: {
          embeddedDir: ctx.repoRoot,
          userDir: resolveAgentHome(),
          homeDir: process.env.HOME ? `${process.env.HOME}/.agents` : undefined,
          projectDir: process.cwd(),
        },
        cliArgs: args,
      })
      return true
    case "login": {
      // Provider login flow. Never reads existing credentials — the whole
      // point is to acquire (or replace) them. Email pre-fill via
      // `--email`/`--email-hint`.
      const emailIdx =
        args.indexOf("--email") !== -1 ? args.indexOf("--email") : args.indexOf("--email-hint")
      const loginHint =
        emailIdx !== -1 && args[emailIdx + 1] && !args[emailIdx + 1].startsWith("-")
          ? args[emailIdx + 1]
          : undefined
      const providerIdx = args.indexOf("--provider")
      const providerId =
        providerIdx !== -1 && args[providerIdx + 1] && !args[providerIdx + 1].startsWith("-")
          ? args[providerIdx + 1]
          : undefined
      const authMethod = readFlagValue("--auth-method")
      const nameIdx = args.indexOf("--name")
      const credentialName =
        nameIdx !== -1 && args[nameIdx + 1] && !args[nameIdx + 1].startsWith("-")
          ? args[nameIdx + 1]
          : undefined
      const code = await runLoginCommand({ loginHint, providerId, authMethod, credentialName })
      process.exit(code)
    }
    case "logout": {
      const providerIdx = args.indexOf("--provider")
      const logoutProviderId =
        providerIdx !== -1 && args[providerIdx + 1] && !args[providerIdx + 1].startsWith("-")
          ? args[providerIdx + 1]
          : undefined
      const code = await runLogoutCommand({ providerId: logoutProviderId })
      process.exit(code)
    }
    case "auth-status": {
      const code = await runAuthStatusCommand()
      process.exit(code)
    }
    case "run":
      return false
  }
  return false
}
