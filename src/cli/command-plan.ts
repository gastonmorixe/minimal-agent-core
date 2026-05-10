export type CommandName =
  | "dump"
  | "sessions"
  | "list-flags"
  | "list-spinners"
  | "list-models"
  | "login"
  | "logout"
  | "auth-status"
  | "run"

export interface CommandCapabilities {
  needsStartupUi: boolean
  needsAuth: boolean
  needsNetwork: boolean
  needsFormatter: boolean
  needsQuota: boolean
  supportsPromptInput: boolean
}

export interface CommandPlan extends CommandCapabilities {
  command: CommandName
}

export interface PlanCommandInput {
  dumpArg?: string
  wantListSessions: boolean
  wantListFlags: boolean
  wantListSpinners: boolean
  wantListModels: boolean
  /**
   * Auth-related top-level commands. Routed BEFORE `run` so they bypass
   * credential acquisition — login can't depend on already being logged
   * in, and logout / auth-status never need network.
   */
  wantLogin?: boolean
  wantLogout?: boolean
  wantAuthStatus?: boolean
}

function capabilities(command: CommandName): CommandCapabilities {
  switch (command) {
    case "dump":
    case "sessions":
    case "list-flags":
    case "list-spinners":
    case "logout":
    case "auth-status":
      return {
        needsStartupUi: false,
        needsAuth: false,
        needsNetwork: false,
        needsFormatter: false,
        needsQuota: false,
        supportsPromptInput: false,
      }
    case "login":
      // Login is a one-shot command that hits the OAuth endpoints itself
      // (network=true) but it is **not** allowed to depend on already-
      // valid credentials (auth=false). The startup UI / formatter /
      // quota check are all skipped.
      return {
        needsStartupUi: false,
        needsAuth: false,
        needsNetwork: true,
        needsFormatter: false,
        needsQuota: false,
        supportsPromptInput: false,
      }
    case "list-models":
      return {
        needsStartupUi: false,
        needsAuth: true,
        needsNetwork: true,
        needsFormatter: false,
        needsQuota: false,
        supportsPromptInput: false,
      }
    case "run":
      return {
        needsStartupUi: true,
        needsAuth: true,
        needsNetwork: true,
        needsFormatter: true,
        needsQuota: true,
        supportsPromptInput: true,
      }
    default: {
      const _exhaustive: never = command
      throw new Error(`unknown command: ${_exhaustive}`)
    }
  }
}

/**
 * Decide which top-level command should run, then expose an explicit
 * capability profile so startup dependencies are only initialized when needed.
 *
 * Precedence: dump > sessions > list-flags > list-spinners > list-models >
 * login > logout > auth-status > run. Auth subcommands sit ahead of `run`
 * but after the read-only inspection commands so a `--sessions --logout`
 * combo still falls through to sessions (whoever wrote that flag combo
 * almost certainly meant the read).
 */
export function planCommand(input: PlanCommandInput): CommandPlan {
  const command: CommandName = input.dumpArg
    ? "dump"
    : input.wantListSessions
      ? "sessions"
      : input.wantListFlags
        ? "list-flags"
        : input.wantListSpinners
          ? "list-spinners"
          : input.wantListModels
            ? "list-models"
            : input.wantLogin
              ? "login"
              : input.wantLogout
                ? "logout"
                : input.wantAuthStatus
                  ? "auth-status"
                  : "run"

  return {
    command,
    ...capabilities(command),
  }
}
