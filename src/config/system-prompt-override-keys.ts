/**
 * Env and config key names for the system-prompt override parts, as data.
 *
 * Core config reads the config keys from `config.jsonc`. The CLI flag names
 * for the same parts live with the CLI flag specs
 * (`minimal-agent-cli/src/cli/system-prompt-override-flags.ts`), so no flag name is defined in
 * both places (spec S26).
 *
 * @module config/system-prompt-override-keys
 */

import type { SystemPromptOverridePart } from "../llm/system-prompt-overrides.ts"

/** Env and config naming for one system-prompt override part. */
export interface SystemPromptOverrideKeySpec {
  readonly part: SystemPromptOverridePart
  readonly envVar: string
  readonly fileEnvVar: string
  readonly configKey: string
  readonly configFileKey: string
}

/** Env and config keys for every system-prompt override part. */
export const SYSTEM_PROMPT_OVERRIDE_KEY_SPECS: readonly SystemPromptOverrideKeySpec[] = [
  {
    part: "full",
    envVar: "MINIMAL_AGENT_SYSTEM_PROMPT",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_PROMPT_FILE",
    configKey: "full",
    configFileKey: "fullFile",
  },
  {
    part: "identity",
    envVar: "MINIMAL_AGENT_SYSTEM_IDENTITY",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_IDENTITY_FILE",
    configKey: "identity",
    configFileKey: "identityFile",
  },
  {
    part: "providerPreamble",
    envVar: "MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE",
    fileEnvVar: "MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE_FILE",
    configKey: "providerPreamble",
    configFileKey: "providerPreambleFile",
  },
  {
    part: "instructions",
    envVar: "MINIMAL_AGENT_SYSTEM_INSTRUCTIONS",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_INSTRUCTIONS_FILE",
    configKey: "instructions",
    configFileKey: "instructionsFile",
  },
  {
    part: "loopSafety",
    envVar: "MINIMAL_AGENT_SYSTEM_LOOP_SAFETY",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_LOOP_SAFETY_FILE",
    configKey: "loopSafety",
    configFileKey: "loopSafetyFile",
  },
  {
    part: "toolOutputConventions",
    envVar: "MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS_FILE",
    configKey: "toolOutputConventions",
    configFileKey: "toolOutputConventionsFile",
  },
  {
    part: "sessionContext",
    envVar: "MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT_FILE",
    configKey: "sessionContext",
    configFileKey: "sessionContextFile",
  },
]
