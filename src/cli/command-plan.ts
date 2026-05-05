export type CommandName =
  | "dump"
  | "sessions"
  | "list-flags"
  | "list-spinners"
  | "list-models"
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
}

function capabilities(command: CommandName): CommandCapabilities {
  switch (command) {
    case "dump":
    case "sessions":
    case "list-flags":
    case "list-spinners":
      return {
        needsStartupUi: false,
        needsAuth: false,
        needsNetwork: false,
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
            : "run"

  return {
    command,
    ...capabilities(command),
  }
}
