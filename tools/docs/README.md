# docs-tooling: why typedoc is isolated here

**Do not "simplify" this back into the root `package.json`.** It is here on purpose.

## The problem

TypeScript 7.0 (GA 2026-07-08) is a Go rewrite that **ships no programmatic
compiler API**. Per the [TS7 GA announcement][ts7ga]: *"While TypeScript 7.0 is
here, it does not ship with an API."* A stable API is not expected before TS 7.1,
which Microsoft has dated only as *"at least several months"* out.

typedoc needs the compiler API to read types for doc extraction. typedoc's
`peerDependencies` hard-cap at `6.0.x`, and typedoc@0.28.20 **hard-crashes** on
`typescript@7` with `TypeError: Cannot read properties of undefined (reading
'PropertyDeclaration')` (its `ts.SyntaxKind` is undefined against the v7 module).
The typedoc maintainer ([TypeStrong/typedoc#3068][td3068], Dec 2025) states the
Go-API port *"hasn't even been started yet"* and is *"6-12 months away from even
getting started."* So docs generation stays pinned to the TS 6.0 API for the
foreseeable future, not weeks.

## Why not the official `@typescript/typescript6` root alias

Microsoft's recommended `"typescript": "npm:@typescript/typescript6@^6.0.2"` root
alias **deadlocks under bun**: the compat package's own internal
`require("typescript")` self-references the bare-name alias and collapses to an
empty object, so typedoc receives a broken API and hangs. The compat package's
API is fine under its real name; the bare-name alias is the dead end.

## The arrangement

This is a bun **workspace member** with its own `typescript@6` + typedoc. A single
root `bun install` keeps the root on `typescript@7` and nests `typescript@6` here,
so the two incompatible ranges never collide. The root `docs:check` script invokes
`tools/docs/node_modules/.bin/typedoc`, which resolves the nested v6 API. Root
`tsc` stays TypeScript 7.

Nothing in `src/` or `plugin-api/` imports the `typescript` module as a JS API
(verified: zero matches), so typedoc is the only consumer of the 6.0 API and this
is the only place the old compiler needs to live.

Revisit when typedoc ships support for the TS 7.1+ programmatic API. Until then,
this isolation is the intended long-term state.

[ts7ga]: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
[td3068]: https://github.com/TypeStrong/typedoc/discussions/3068
