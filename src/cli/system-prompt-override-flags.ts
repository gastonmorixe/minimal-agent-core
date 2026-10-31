/**
 * CLI flag names for system-prompt override plumbing.
 *
 * Kept in one pure module so prompt extraction, startup resolution, and help
 * text cannot drift on which flags take values. The env and config key names
 * are core config data (`src/config/system-prompt-override-keys.ts`). This
 * module adds the CLI flag names to them, so no flag name lives in core
 * config (spec S26).
 *
 * @module cli/system-prompt-override-flags
 */

import {
  SYSTEM_PROMPT_OVERRIDE_KEY_SPECS,
  type SystemPromptOverrideKeySpec,
} from "../config/system-prompt-override-keys.ts"
import type { SystemPromptOverridePart } from "../llm/system-prompt-overrides.ts"

/** The three CLI flags for one system-prompt override part. */
interface SystemPromptOverrideFlagNames {
  readonly valueFlag: string
  readonly fileFlag: string
  readonly noFlag: string
}

/** Flag/env/config naming for one system-prompt override part. */
export interface SystemPromptOverrideFlagSpec
  extends SystemPromptOverrideKeySpec,
    SystemPromptOverrideFlagNames {}

/** CLI flag names per override part. */
const FLAG_NAMES: Readonly<Record<SystemPromptOverridePart, SystemPromptOverrideFlagNames>> = {
  full: {
    valueFlag: "--system-prompt",
    fileFlag: "--system-prompt-file",
    noFlag: "--no-system-prompt",
  },
  identity: {
    valueFlag: "--system-identity",
    fileFlag: "--system-identity-file",
    noFlag: "--no-system-identity",
  },
  providerPreamble: {
    valueFlag: "--provider-system-preamble",
    fileFlag: "--provider-system-preamble-file",
    noFlag: "--no-provider-system-preamble",
  },
  instructions: {
    valueFlag: "--system-instructions",
    fileFlag: "--system-instructions-file",
    noFlag: "--no-system-instructions",
  },
  loopSafety: {
    valueFlag: "--system-loop-safety",
    fileFlag: "--system-loop-safety-file",
    noFlag: "--no-system-loop-safety",
  },
  toolOutputConventions: {
    valueFlag: "--system-tool-output-conventions",
    fileFlag: "--system-tool-output-conventions-file",
    noFlag: "--no-system-tool-output-conventions",
  },
  sessionContext: {
    valueFlag: "--system-session-context",
    fileFlag: "--system-session-context-file",
    noFlag: "--no-system-session-context",
  },
}

/** Supported startup system-prompt override flags, in core key-spec order. */
export const SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS: readonly SystemPromptOverrideFlagSpec[] =
  SYSTEM_PROMPT_OVERRIDE_KEY_SPECS.map((spec) => Object.assign({}, spec, FLAG_NAMES[spec.part]))

/** Flags that consume the next argv token as a value. */
export const SYSTEM_PROMPT_OVERRIDE_VALUE_FLAGS: readonly string[] =
  SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS.flatMap((spec) => [spec.valueFlag, spec.fileFlag])

/** Flags that consume no value. */
export const SYSTEM_PROMPT_OVERRIDE_NO_VALUE_FLAGS: readonly string[] = [
  ...SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS.map((spec) => spec.noFlag),
  "--unsafe-system-prompt-overrides",
]
