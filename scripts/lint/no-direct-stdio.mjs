// oxlint JS plugin (tested on oxlint 1.92.0): ban direct writes to the process stdout/stderr.
// Scope-aware: a LOCAL `process`/`console`/`Bun` (param, const, import) is not the global and is not flagged.
const STD = new Set(["stdout", "stderr"])
// Reads never put bytes on the terminal.
const READS = new Set([
  "columns",
  "rows",
  "isTTY",
  "fd",
  "getWindowSize",
  "hasColors",
  "getColorDepth",
  "on",
  "once",
  "off",
  "addListener",
  "removeListener",
  "removeAllListeners",
  "listenerCount",
])
const ROOT = {
  process: "process",
  console: "console",
  Bun: "bun",
  globalThis: "global",
  global: "global",
}
const VIA_GLOBAL = { process: "process", console: "console", Bun: "bun" }
const WRAP = new Set([
  "TSNonNullExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
])
const NOT_A_REF = new Set([
  "ImportSpecifier",
  "ExportSpecifier",
  "LabeledStatement",
  "BreakStatement",
  "ContinueStatement",
  "TSEnumMember",
  "TSTypeQuery",
  "TSQualifiedName",
  "TSTypeReference",
])
const KEYED = new Set([
  "Property",
  "PropertyDefinition",
  "MethodDefinition",
  "AccessorProperty",
  "TSPropertySignature",
  "TSMethodSignature",
])
const DEV = /^\/dev\/(?:stdout|stderr|fd\/[12])$/
const MESSAGES = {
  stream:
    "Direct use of process.stdout/stderr. Go through the diagnostic bus, a Diagnostics handle, the plugin logger or an injected writer (reads like .columns/.isTTY/.on('resize') are fine).",
  console:
    "console.* writes to the terminal directly. Use the diagnostic bus or an injected writer.",
  bun: "Bun.stdout/Bun.stderr write to the terminal directly. Use an injected writer.",
  writeSync: "Writing to fd 1/2 directly bypasses every sink. Use an injected writer.",
  inherit:
    "A child process with stdio/stdout/stderr 'inherit' bypasses every sink. Pipe it and forward through a writer.",
  devstd: "/dev/stdout and /dev/stderr are direct terminal writes. Use an injected writer.",
  warning: "process.emitWarning / util.debuglog print outside the bus. Use the diagnostic bus.",
}
const nameOf = (key, computed) =>
  computed ? (key.type === "Literal" ? String(key.value) : "*") : (key.name ?? String(key.value))

export default {
  meta: { name: "ma" },
  rules: {
    "no-direct-stdio": {
      meta: {
        type: "problem",
        messages: MESSAGES,
        schema: [
          {
            type: "object",
            properties: { allow: { type: "array", items: { enum: Object.keys(MESSAGES) } } },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const sc = context.sourceCode
        const allow = new Set(context.options[0]?.allow ?? [])
        const report = (node, messageId) => {
          if (!allow.has(messageId)) context.report({ node, messageId })
        }
        const up = (n) => {
          let p = n.parent
          while (p && WRAP.has(p.type)) {
            n = p
            p = p.parent
          }
          return [n, p]
        }
        const isTypeof = (p) => p?.type === "UnaryExpression" && p.operator === "typeof"
        // Which global does identifier `id` denote? null = a LOCAL variable (shadowing), so not ours.
        const isLocal = (id) => {
          for (let s = sc.getScope(id); s; s = s.upper) {
            const v = s.set.get(id.name)
            if (v) return v.defs.length > 0 // no defs = an implicit lib/env global
          }
          return false
        }
        const origin = (id) => (isLocal(id) ? null : (ROOT[id.name] ?? null))
        const std = (m) => {
          // m is an expression that IS process.stdout / process.stderr
          const [top, p] = up(m)
          if (
            p?.type === "MemberExpression" &&
            p.object === top &&
            READS.has(nameOf(p.property, p.computed))
          )
            return
          report(m, "stream")
        }
        const proc = (n) => {
          // n is an expression that IS the global `process`
          const [top, p] = up(n)
          if (p?.type === "MemberExpression" && p.object === top) {
            const k = nameOf(p.property, p.computed)
            if (k === "emitWarning") report(p, "warning")
            else if (STD.has(k) || k === "*") std(p)
          } else if (
            p?.type === "VariableDeclarator" &&
            p.init === top &&
            p.id.type === "ObjectPattern"
          ) {
            if (
              p.id.properties.some(
                (x) => x.type === "RestElement" || STD.has(nameOf(x.key, x.computed)),
              )
            )
              report(p, "stream")
          } else if (!isTypeof(p)) report(n, "stream") // bare `process` value: `const p = process`, fn(process)
        }
        const dispatch = (root, n) => {
          const [top, p] = up(n)
          if (root === "console") {
            if (!isTypeof(p)) report(n, "console")
          } else if (root === "process") proc(n)
          else if (root === "bun") {
            if (
              p?.type === "MemberExpression" &&
              p.object === top &&
              STD.has(nameOf(p.property, p.computed))
            )
              report(p, "bun")
          } else if (p?.type === "MemberExpression" && p.object === top) {
            // globalThis.X / global.X
            const via = VIA_GLOBAL[nameOf(p.property, p.computed)]
            if (via) dispatch(via, p)
          }
        }
        const isFd = (a) => a?.type === "Literal" && (a.value === 1 || a.value === 2)
        const inherit = (x) => x?.type === "Literal" && x.value === "inherit"
        return {
          Identifier(id) {
            const root = ROOT[id.name]
            const p = id.parent
            if (!root || NOT_A_REF.has(p.type)) return
            if (p.type === "MemberExpression" && p.property === id && !p.computed) return
            if (KEYED.has(p.type) && p.key === id && !p.computed && p.value !== id) return
            if (origin(id) === root) dispatch(root, id)
          },
          ImportDeclaration(d) {
            const src = String(d.source.value)
            if (/^(?:node:)?console$/.test(src)) report(d, "console")
            if (
              /^(?:node:)?util$/.test(src) &&
              d.specifiers.some((s) => s.imported?.name === "debuglog")
            )
              report(d, "warning")
            if (!/^(?:node:)?process$/.test(src)) return
            for (const s of d.specifiers) {
              if (s.type === "ImportSpecifier" && !STD.has(s.imported.name)) continue
              for (const v of sc.getDeclaredVariables(s))
                for (const r of v.references)
                  (s.type === "ImportSpecifier" ? std : proc)(r.identifier)
            }
          },
          CallExpression(c) {
            const f = c.callee
            const n = f.type === "MemberExpression" ? nameOf(f.property, f.computed) : f.name
            const a = c.arguments[0]
            if (
              f.type === "Identifier" &&
              f.name === "require" &&
              a?.type === "Literal" &&
              /^(?:node:)?process$/.test(String(a.value)) &&
              !isLocal(f)
            )
              return proc(c)
            if (
              (n === "writeSync" || n === "writevSync") &&
              a &&
              (isFd(a) || /\bstd(?:out|err)\.fd$/.test(sc.getText(a)))
            )
              report(c, "writeSync")
            else if (
              n === "write" &&
              f.type === "MemberExpression" &&
              f.object.type === "Identifier" &&
              f.object.name === "Bun" &&
              isFd(a) &&
              origin(f.object) === "bun"
            )
              report(c, "writeSync")
          },
          Property(p) {
            if (p.parent?.type !== "ObjectExpression") return
            const k = nameOf(p.key, p.computed)
            const v = p.value
            if ((k === "stdio" || k === "stdout" || k === "stderr") && inherit(v))
              report(p, "inherit")
            else if (
              k === "stdio" &&
              v.type === "ArrayExpression" &&
              (inherit(v.elements[1]) || inherit(v.elements[2]))
            )
              report(p, "inherit")
          },
          MemberExpression(m) {
            if (nameOf(m.property, m.computed) === "debuglog") report(m, "warning")
          },
          Literal(l) {
            if (typeof l.value === "string" && DEV.test(l.value)) report(l, "devstd")
          },
        }
      },
    },
  },
}
