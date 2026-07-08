/**
 * CLI/env/config names for system-prompt override plumbing.
 *
 * Kept in one pure module so prompt extraction, startup resolution, and help
 * text cannot drift on which flags take values.
 *
 * @module cli/system-prompt-override-flags
 */

import type { SystemPromptOverridePart } from "../llm/system-prompt-overrides.ts"

/** Flag/env/config naming for one system-prompt override part. */
export interface SystemPromptOverrideFlagSpec {
  readonly part: SystemPromptOverridePart
  readonly valueFlag: string
  readonly fileFlag: string
  readonly noFlag: string
  readonly envVar: string
  readonly fileEnvVar: string
  readonly configKey: string
  readonly configFileKey: string
}

/** Supported startup system-prompt override flags. */
export const SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS: readonly SystemPromptOverrideFlagSpec[] = [
  {
    part: "full",
    valueFlag: "--system-prompt",
    fileFlag: "--system-prompt-file",
    noFlag: "--no-system-prompt",
    envVar: "MINIMAL_AGENT_SYSTEM_PROMPT",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_PROMPT_FILE",
    configKey: "full",
    configFileKey: "fullFile",
  },
  {
    part: "identity",
    valueFlag: "--system-identity",
    fileFlag: "--system-identity-file",
    noFlag: "--no-system-identity",
    envVar: "MINIMAL_AGENT_SYSTEM_IDENTITY",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_IDENTITY_FILE",
    configKey: "identity",
    configFileKey: "identityFile",
  },
  {
    part: "providerPreamble",
    valueFlag: "--provider-system-preamble",
    fileFlag: "--provider-system-preamble-file",
    noFlag: "--no-provider-system-preamble",
    envVar: "MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE",
    fileEnvVar: "MINIMAL_AGENT_PROVIDER_SYSTEM_PREAMBLE_FILE",
    configKey: "providerPreamble",
    configFileKey: "providerPreambleFile",
  },
  {
    part: "instructions",
    valueFlag: "--system-instructions",
    fileFlag: "--system-instructions-file",
    noFlag: "--no-system-instructions",
    envVar: "MINIMAL_AGENT_SYSTEM_INSTRUCTIONS",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_INSTRUCTIONS_FILE",
    configKey: "instructions",
    configFileKey: "instructionsFile",
  },
  {
    part: "loopSafety",
    valueFlag: "--system-loop-safety",
    fileFlag: "--system-loop-safety-file",
    noFlag: "--no-system-loop-safety",
    envVar: "MINIMAL_AGENT_SYSTEM_LOOP_SAFETY",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_LOOP_SAFETY_FILE",
    configKey: "loopSafety",
    configFileKey: "loopSafetyFile",
  },
  {
    part: "toolOutputConventions",
    valueFlag: "--system-tool-output-conventions",
    fileFlag: "--system-tool-output-conventions-file",
    noFlag: "--no-system-tool-output-conventions",
    envVar: "MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_TOOL_OUTPUT_CONVENTIONS_FILE",
    configKey: "toolOutputConventions",
    configFileKey: "toolOutputConventionsFile",
  },
  {
    part: "sessionContext",
    valueFlag: "--system-session-context",
    fileFlag: "--system-session-context-file",
    noFlag: "--no-system-session-context",
    envVar: "MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT",
    fileEnvVar: "MINIMAL_AGENT_SYSTEM_SESSION_CONTEXT_FILE",
    configKey: "sessionContext",
    configFileKey: "sessionContextFile",
  },
]

/** Flags that consume the next argv token as a value. */
export const SYSTEM_PROMPT_OVERRIDE_VALUE_FLAGS: readonly string[] =
  SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS.flatMap((spec) => [spec.valueFlag, spec.fileFlag])

/** Flags that consume no value. */
export const SYSTEM_PROMPT_OVERRIDE_NO_VALUE_FLAGS: readonly string[] = [
  ...SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS.map((spec) => spec.noFlag),
  "--unsafe-system-prompt-overrides",
]
