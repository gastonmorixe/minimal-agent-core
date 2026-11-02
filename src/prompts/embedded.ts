/**
 * Compile-time embedded prompt texts.
 *
 * `bun build --compile` does not embed `src/prompts/*.md` files read via
 * `readFileSync`, so the compiled binary failed with
 * `ENOENT /$bunfs/prompts/tools/bash.md`. Each prompt file is instead imported
 * with `with { type: "text" }`, which Bun inlines at build time (raw prose;
 * NOT the `md` loader, which would render HTML). `loadPromptText` in
 * `prompts.ts` serves core's own prompt paths from this map and reads every
 * other path (plugin prompts, temp files) from disk. From source, Bun reads
 * these imports again on each start, so a `.md` edit takes effect on the next
 * run.
 *
 * Keys are paths relative to `src/prompts/` (see `findEmbeddedPrompt`).
 * When adding a new prompt `.md` file, add its import + map entry here. A
 * test in `prompts.test.ts` fails when this map and the files on disk differ.
 *
 * The triple-slash reference pulls in the `*.md` module declaration. A
 * consumer (the CLI, the web server) typechecks this file through
 * `node_modules/@minimal-agent/core` with its own `include`, which does not
 * contain `md.d.ts`, so the reference must live here.
 *
 * @module embedded
 */

// oxlint-disable-next-line typescript/triple-slash-reference -- md.d.ts declares the global `*.md` module; a global declaration cannot be imported
/// <reference path="./md.d.ts" />

import identityNeutral from "./identity.neutral.md" with { type: "text" }
import instructions from "./instructions.md" with { type: "text" }
import loopSafetyAck from "./loop-safety/ack.md" with { type: "text" }
import loopSafetyCheckpointCooldown from "./loop-safety/checkpoint-cooldown.tmpl.md" with {
  type: "text",
}
import loopSafetyCheckpointPlain from "./loop-safety/checkpoint-plain.tmpl.md" with { type: "text" }
import loopSafetyHeading from "./loop-safety/heading.md" with { type: "text" }
import loopSafetyIntro from "./loop-safety/intro.md" with { type: "text" }
import runtimeOutputPreview from "./runtime/output-preview.tmpl.md" with { type: "text" }
import runtimeOutputPreviewHint from "./runtime/output-preview-hint.tmpl.md" with { type: "text" }
import runtimeOutputPreviewHintBash from "./runtime/output-preview-hint-bash.tmpl.md" with {
  type: "text",
}
import runtimeOutputPreviewRecover from "./runtime/output-preview-recover.tmpl.md" with {
  type: "text",
}
import runtimeOutputTruncated from "./runtime/output-truncated.md" with { type: "text" }
import runtimeReflectionCheckpoint from "./runtime/reflection-checkpoint.tmpl.md" with {
  type: "text",
}
import runtimeResponseTruncatedPlaceholder from "./runtime/response-truncated-placeholder.md" with {
  type: "text",
}
import runtimeSessionResumed from "./runtime/session-resumed.md" with { type: "text" }
import runtimeStreamInterrupted from "./runtime/stream-interrupted.md" with { type: "text" }
import runtimeStreamInterruptedContinue from "./runtime/stream-interrupted-continue.md" with {
  type: "text",
}
import runtimeTurnAborted from "./runtime/turn-aborted.md" with { type: "text" }
import toolOutputConventions from "./tool-output-conventions.md" with { type: "text" }
import toolsBash from "./tools/bash.md" with { type: "text" }
import toolsEdit from "./tools/edit.md" with { type: "text" }
import toolsFilesStats from "./tools/files-stats.md" with { type: "text" }
import toolsGlob from "./tools/glob.md" with { type: "text" }
import toolsGrep from "./tools/grep.md" with { type: "text" }
import toolsMode from "./tools/mode.md" with { type: "text" }
import toolsRead from "./tools/read.md" with { type: "text" }
import toolsWrite from "./tools/write.md" with { type: "text" }

/**
 * Embedded prompt texts keyed by path relative to `src/prompts/`.
 * Values are inlined by Bun at compile time.
 */
export const EMBEDDED_PROMPTS: Record<string, string> = {
  "identity.neutral.md": identityNeutral,
  "instructions.md": instructions,
  "loop-safety/ack.md": loopSafetyAck,
  "loop-safety/checkpoint-cooldown.tmpl.md": loopSafetyCheckpointCooldown,
  "loop-safety/checkpoint-plain.tmpl.md": loopSafetyCheckpointPlain,
  "loop-safety/heading.md": loopSafetyHeading,
  "loop-safety/intro.md": loopSafetyIntro,
  "runtime/output-preview-hint-bash.tmpl.md": runtimeOutputPreviewHintBash,
  "runtime/output-preview-hint.tmpl.md": runtimeOutputPreviewHint,
  "runtime/output-preview-recover.tmpl.md": runtimeOutputPreviewRecover,
  "runtime/output-preview.tmpl.md": runtimeOutputPreview,
  "runtime/output-truncated.md": runtimeOutputTruncated,
  "runtime/reflection-checkpoint.tmpl.md": runtimeReflectionCheckpoint,
  "runtime/response-truncated-placeholder.md": runtimeResponseTruncatedPlaceholder,
  "runtime/session-resumed.md": runtimeSessionResumed,
  "runtime/stream-interrupted-continue.md": runtimeStreamInterruptedContinue,
  "runtime/stream-interrupted.md": runtimeStreamInterrupted,
  "runtime/turn-aborted.md": runtimeTurnAborted,
  "tool-output-conventions.md": toolOutputConventions,
  "tools/bash.md": toolsBash,
  "tools/edit.md": toolsEdit,
  "tools/files-stats.md": toolsFilesStats,
  "tools/glob.md": toolsGlob,
  "tools/grep.md": toolsGrep,
  "tools/mode.md": toolsMode,
  "tools/read.md": toolsRead,
  "tools/write.md": toolsWrite,
}
