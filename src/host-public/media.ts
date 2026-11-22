/**
 * Public media kit for hosts: `@minimal-agent/core/host-kit/media`.
 *
 * The media gate, the session registry and the token format that a host
 * needs to turn a paste or a drop into `[Image #id …]` tokens. The host owns
 * the paste and clipboard code (the CLI keeps it in `src/paste/`); core keeps
 * only the media model it reads. `processDiagnostics` is the default
 * diagnostics handle for a host component built without one (S20).
 *
 * @module host-public/media
 */

export type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
export { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"
export { defaultMediaLimits } from "../media/default-limits.ts"
export { checkMedia, type MediaLimits, type Verdict } from "../media/limits.ts"
export { isTypedMediaPath } from "../media/probe.ts"
export { createMediaRegistry, type MediaRegistry } from "../media/registry.ts"
export { getSessionMediaRegistry } from "../media/session-registry.ts"
export { formatMediaToken, parseMediaTokens } from "../media/token.ts"
export { type ModelMediaContext, resolveModelMediaContext } from "../media/tool-context.ts"
