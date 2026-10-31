/**
 * Narrow public re-export for `@minimal-agent/core/host/bash-cwd`. It
 * exports only `setBashCwdChangeListener` from `src/tools/tools.ts`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * The sticky Bash cwd is module state in the core tool engine. A host
 * connects this listener to `LifecyclePort.cwdDidChange`. Then
 * observe-only plugins get `cwd.didChange`. The CLI entry point needs it
 * (S34 Phase 3). It must register on the core module that the Bash tool
 * updates.
 *
 * @module host-public/bash-cwd
 */

export { setBashCwdChangeListener } from "../tools/tools.ts"
