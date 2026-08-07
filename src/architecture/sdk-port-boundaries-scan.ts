/**
 * TypeScript-AST scanner for the SDK port-boundary architecture ratchet.
 *
 * @module architecture/sdk-port-boundaries-scan
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import * as ts from "typescript/unstable/ast"
import { API } from "typescript/unstable/sync"

export type SdkImportForm = "import" | "export-from" | "dynamic-import" | "require"

export interface SdkImportSite {
  readonly file: string
  readonly line: number
  readonly form: SdkImportForm
  readonly specifier: string
  readonly resolved: string
  readonly typeOnly: boolean
}

export interface SdkTokenViolation {
  readonly file: string
  readonly line: number
  readonly token: string
  readonly detail: string
}

export interface SdkScanResult {
  readonly imports: readonly SdkImportSite[]
  readonly computedDynamicImports: readonly SdkTokenViolation[]
  readonly ambientEscapes: readonly SdkTokenViolation[]
}

const FORBIDDEN_ROOTS: ReadonlyMap<string, string> = new Map([
  ["src/host", "host implementation"],
  ["src/plugins/loader.ts", "concrete plugin loader"],
  ["src/plugins/hooks", "concrete plugin hook implementation"],
  ["src/agent/repl", "interactive REPL implementation"],
  ["src/agent/agent", "legacy host agent implementation"],
  ["src/ui", "UI/TUI implementation"],
  ["src/terminal", "terminal/input implementation"],
  ["src/input", "input implementation"],
  ["src/editor-controller", "editor controller"],
  ["src/compositor", "compositor"],
  ["src/startup", "startup"],
  ["src/commands", "commands"],
  ["src/modes", "concrete mode collaborator"],
  ["src/session", "concrete session collaborator"],
  ["src/status", "concrete status collaborator"],
])

const OUTPUT_CONSOLE_METHODS = new Set([
  "assert",
  "clear",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "trace",
  "warn",
])

function resolveSpecifier(file: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier
  return posix.normalize(posix.join("src/sdk", posix.dirname(file), specifier))
}

function isLocalAbsoluteSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("/") ||
    specifier.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(specifier) ||
    /^file:/iu.test(specifier)
  )
}

function forbiddenTarget(resolved: string): string | undefined {
  for (const [root, label] of FORBIDDEN_ROOTS) {
    if (resolved === root || resolved.startsWith(`${root}/`)) return label
  }
  return undefined
}

type ScopeNode =
  | ts.SourceFile
  | ts.Block
  | ts.CatchClause
  | ts.FunctionLikeDeclaration
  | ts.ForStatement
  | ts.ForInStatement
  | ts.ForOfStatement

function isScopeNode(node: ts.Node): node is ScopeNode {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isFunctionLikeDeclaration(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  )
}

function bindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text)
    return
  }
  for (const element of name.elements)
    if (!ts.isOmittedExpression(element) && element.name !== undefined)
      bindingNames(element.name, names)
}

/** Build lexical value-binding sets before scanning so uses before declarations shadow globals too. */
function collectScopes(sourceFile: ts.SourceFile): Map<ScopeNode, Set<string>> {
  const bindings = new Map<ScopeNode, Set<string>>()
  const ensure = (scope: ScopeNode): Set<string> => {
    let names = bindings.get(scope)
    if (names === undefined) {
      names = new Set()
      bindings.set(scope, names)
    }
    return names
  }
  const nearestFunctionScope = (scopes: readonly ScopeNode[]): ScopeNode =>
    [...scopes]
      .reverse()
      .find((scope) => ts.isSourceFile(scope) || ts.isFunctionLikeDeclaration(scope)) ?? sourceFile

  const visit = (node: ts.Node, inheritedScopes: readonly ScopeNode[]): void => {
    const scopes = isScopeNode(node) ? [...inheritedScopes, node] : inheritedScopes
    const current = scopes[scopes.length - 1] ?? sourceFile
    ensure(current)

    if (ts.isImportClause(node) && node.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
      if (node.name !== undefined) ensure(sourceFile).add(node.name.text)
      const bindingsNode = node.namedBindings
      if (bindingsNode !== undefined) {
        if (ts.isNamespaceImport(bindingsNode)) ensure(sourceFile).add(bindingsNode.name.text)
        else
          for (const element of bindingsNode.elements)
            if (!element.isTypeOnly) ensure(sourceFile).add(element.name.text)
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      ensure(sourceFile).add(node.name.text)
    } else if (ts.isVariableDeclaration(node)) {
      const list = node.parent
      const target =
        ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) === 0
          ? nearestFunctionScope(scopes)
          : current
      bindingNames(node.name, ensure(target))
    } else if (ts.isParameterDeclaration(node)) {
      bindingNames(node.name, ensure(current))
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name !== undefined)
        ensure(inheritedScopes[inheritedScopes.length - 1] ?? sourceFile).add(node.name.text)
    } else if (ts.isFunctionExpression(node) && node.name !== undefined) {
      ensure(current).add(node.name.text)
    } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      bindingNames(node.variableDeclaration.name, ensure(node))
    }

    node.forEachChild((child) => visit(child, scopes))
  }

  visit(sourceFile, [])
  return bindings
}

function enclosingScopes(node: ts.Node): ScopeNode[] {
  const scopes: ScopeNode[] = []
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (isScopeNode(current)) scopes.push(current)
  }
  return scopes
}

function isShadowed(
  identifier: ts.Identifier,
  bindings: ReadonlyMap<ScopeNode, ReadonlySet<string>>,
): boolean {
  return enclosingScopes(identifier).some(
    (scope) => bindings.get(scope)?.has(identifier.text) === true,
  )
}

function staticString(expression: ts.Expression): string | undefined {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : undefined
}

function propertyAccess(
  expression: ts.Expression,
): { readonly base: ts.Expression; readonly name: string } | undefined {
  if (ts.isPropertyAccessExpression(expression))
    return { base: expression.expression, name: expression.name.text }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined) {
    const name = staticString(expression.argumentExpression)
    if (name !== undefined) return { base: expression.expression, name }
  }
  return undefined
}

function isUnshadowedIdentifier(
  expression: ts.Expression,
  name: string,
  bindings: ReadonlyMap<ScopeNode, ReadonlySet<string>>,
): expression is ts.Identifier {
  return (
    ts.isIdentifier(expression) && expression.text === name && !isShadowed(expression, bindings)
  )
}

function isGlobalObject(
  expression: ts.Expression,
  bindings: ReadonlyMap<ScopeNode, ReadonlySet<string>>,
): boolean {
  return (
    isUnshadowedIdentifier(expression, "globalThis", bindings) ||
    isUnshadowedIdentifier(expression, "global", bindings)
  )
}

function globalMember(
  expression: ts.Expression,
  bindings: ReadonlyMap<ScopeNode, ReadonlySet<string>>,
): string | undefined {
  const access = propertyAccess(expression)
  return access !== undefined && isGlobalObject(access.base, bindings) ? access.name : undefined
}

function isGlobalReference(
  expression: ts.Expression,
  name: string,
  bindings: ReadonlyMap<ScopeNode, ReadonlySet<string>>,
): boolean {
  return (
    isUnshadowedIdentifier(expression, name, bindings) ||
    globalMember(expression, bindings) === name
  )
}

function isNonReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignatureDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignatureDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isEnumMember(parent) && parent.name === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    (ts.isModuleDeclaration(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isParameterDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node)
  )
}

function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true
  if (clause.name !== undefined || clause.namedBindings === undefined) return false
  return (
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.every((item) => item.isTypeOnly)
  )
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true
  return (
    node.exportClause !== undefined &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((item) => item.isTypeOnly)
  )
}

/** Scan one parsed SDK source file through lexical binding scopes. */
function scanParsedSdkSource(sourceFile: ts.SourceFile, file: string): SdkScanResult {
  const bindings = collectScopes(sourceFile)
  const imports: SdkImportSite[] = []
  const computedDynamicImports: SdkTokenViolation[] = []
  const ambientEscapes: SdkTokenViolation[] = []

  const line = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const addComputed = (
    node: ts.Node,
    token: "import()" | "require()" | "module specifier",
    detail?: string,
  ): void => {
    computedDynamicImports.push({
      file,
      line: line(node),
      token,
      detail:
        detail ??
        `computed ${token === "import()" ? "dynamic import" : "require target"} cannot be classified statically`,
    })
  }
  const addImport = (
    node: ts.Node,
    form: SdkImportForm,
    specifier: string,
    typeOnly: boolean,
  ): void => {
    if (isLocalAbsoluteSpecifier(specifier)) {
      addComputed(
        node,
        "module specifier",
        `local absolute or file URL module specifier ${JSON.stringify(specifier)} cannot be classified without repository-root context`,
      )
      return
    }
    imports.push({
      file,
      line: line(node),
      form,
      specifier,
      resolved: resolveSpecifier(file, specifier),
      typeOnly,
    })
  }
  const addAmbient = (node: ts.Node, token: string, detail: string): void => {
    ambientEscapes.push({ file, line: line(node), token, detail })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = staticString(node.moduleSpecifier)
      if (specifier !== undefined)
        addImport(
          node.moduleSpecifier,
          "import",
          specifier,
          importClauseIsTypeOnly(node.importClause),
        )
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = staticString(node.moduleSpecifier)
      if (specifier !== undefined)
        addImport(node.moduleSpecifier, "export-from", specifier, exportDeclarationIsTypeOnly(node))
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined
    ) {
      const specifier = staticString(node.moduleReference.expression)
      if (specifier !== undefined)
        addImport(node.moduleReference.expression, "import", specifier, node.isTypeOnly)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier =
          node.arguments[0] === undefined ? undefined : staticString(node.arguments[0])
        if (specifier === undefined) addComputed(node, "import()")
        else addImport(node.arguments[0], "dynamic-import", specifier, false)
      } else {
        const loader =
          isGlobalReference(node.expression, "require", bindings) ||
          (propertyAccess(node.expression) !== undefined &&
            propertyAccess(node.expression)?.name === "require" &&
            isGlobalObject(propertyAccess(node.expression)!.base, bindings))
        if (loader) {
          const specifier =
            node.arguments[0] === undefined ? undefined : staticString(node.arguments[0])
          if (specifier === undefined) addComputed(node, "require()")
          else addImport(node.arguments[0], "require", specifier, false)
        }
      }
    }

    if (
      ts.isIdentifier(node) &&
      !isNonReferenceIdentifier(node) &&
      isGlobalReference(node, "process", bindings)
    ) {
      const parentAccess = propertyAccess(node.parent as ts.Expression)
      const property = parentAccess?.base === node ? parentAccess.name : undefined
      addAmbient(
        node,
        property === undefined ? "process" : `process.${property}`,
        "SDK code must not access process globals",
      )
    } else if (ts.isExpression(node)) {
      const member = globalMember(node, bindings)
      if (member === "process") {
        const parentAccess = propertyAccess(node.parent as ts.Expression)
        const property = parentAccess?.base === node ? parentAccess.name : undefined
        addAmbient(
          node,
          property === undefined ? "process" : `process.${property}`,
          "SDK code must not access process globals",
        )
      } else if (member === "Bun" || member === "console") {
        const parentAccess = propertyAccess(node.parent as ts.Expression)
        const property = parentAccess?.base === node ? parentAccess.name : undefined
        if (
          member === "Bun" &&
          property !== undefined &&
          ["stdin", "stdout", "stderr"].includes(property)
        )
          addAmbient(node, `Bun.${property}`, "SDK code must not access Bun terminal streams")
        if (member === "console" && property !== undefined && OUTPUT_CONSOLE_METHODS.has(property))
          addAmbient(
            node,
            `console.${property}`,
            "SDK code must not write through the ambient console",
          )
      }
    }

    if (
      ts.isIdentifier(node) &&
      (node.text === "Bun" || node.text === "console") &&
      !isShadowed(node, bindings)
    ) {
      const parentAccess = propertyAccess(node.parent as ts.Expression)
      const property = parentAccess?.base === node ? parentAccess.name : undefined
      if (
        node.text === "Bun" &&
        property !== undefined &&
        ["stdin", "stdout", "stderr"].includes(property)
      )
        addAmbient(node, `Bun.${property}`, "SDK code must not access Bun terminal streams")
      if (node.text === "console" && property !== undefined && OUTPUT_CONSOLE_METHODS.has(property))
        addAmbient(
          node,
          `console.${property}`,
          "SDK code must not write through the ambient console",
        )
    }

    node.forEachChild(visit)
  }

  visit(sourceFile)
  return { imports, computedDynamicImports, ambientEscapes }
}

interface ScanEntry {
  readonly file: string
  readonly source: string
}

const SCAN_CHILD_ARGUMENT = "--sdk-port-boundaries-scan-child"

/**
 * Resolve and validate the Node executable used by the synchronous TypeScript 7 scanner.
 *
 * The scanner child executes this `.ts` module directly, so Node's built-in TypeScript
 * stripping is a required capability rather than an accidental dependency. Set `NODE`
 * to an explicit executable when `node` is not available on `PATH`.
 */
function scannerNodeExecutable(): string {
  const executable = process.env.NODE?.trim() || "node"
  const probe = [
    'if (typeof Bun !== "undefined" || process.release?.name !== "node" || !process.features?.typescript) {',
    '  console.error(`requires genuine Node with built-in TypeScript support; got ${typeof Bun !== "undefined" ? "bun" : (process.release?.name ?? "unknown")} ${process.version}`)',
    "  process.exit(1)",
    "}",
  ].join("\n")
  try {
    execFileSync(executable, ["--input-type=module", "--eval", probe], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    })
  } catch (error) {
    const detail =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error)
    throw new Error(
      `SDK boundary scanner requires a Node executable with built-in TypeScript support. ` +
        `Set NODE to a compatible executable (attempted ${JSON.stringify(executable)}).${detail === "" ? "" : ` ${detail}`}`,
      { cause: error },
    )
  }
  return executable
}

function scanSourcesWithTypeScript(entries: readonly ScanEntry[]): SdkScanResult[] {
  const directory = mkdtempSync(join(tmpdir(), "minimal-agent-sdk-scan-"))
  const config = join(directory, "tsconfig.json")
  const manifest = join(directory, "manifest.json")
  try {
    const files = entries.map((entry, index) => {
      const path = join(directory, `${index}.ts`)
      writeFileSync(path, entry.source)
      return { path, file: entry.file }
    })
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { noLib: true, skipLibCheck: true },
        files: files.map(({ path }) => path),
      }),
    )
    writeFileSync(manifest, JSON.stringify(files))
    const output = execFileSync(
      scannerNodeExecutable(),
      [fileURLToPath(import.meta.url), SCAN_CHILD_ARGUMENT, config, manifest],
      { encoding: "utf8" },
    )
    return JSON.parse(output) as SdkScanResult[]
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

function runScanChild(config: string, manifest: string): void {
  const files = JSON.parse(readFileSync(manifest, "utf8")) as readonly {
    readonly path: string
    readonly file: string
  }[]
  const api = new API()
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    try {
      const project = snapshot.getProject(config)
      if (project === undefined)
        throw new Error(`TypeScript could not open scanner project: ${config}`)
      const results = files.map(({ path, file }) => {
        const sourceFile = project.program.getSourceFile(path)
        if (sourceFile === undefined)
          throw new Error(`TypeScript project did not include scanner input: ${path}`)
        return scanParsedSdkSource(sourceFile, file)
      })
      process.stdout.write(JSON.stringify(results))
    } finally {
      snapshot.dispose()
    }
  } finally {
    api.close()
  }
}

/** Scan one SDK source string through TypeScript 7's exported, explicitly unstable project API. */
export function scanSdkSource(source: string, file: string): SdkScanResult {
  const [result] = scanSourcesWithTypeScript([{ source, file }])
  if (result === undefined) throw new Error("TypeScript scanner returned no result")
  return result
}

/** Collect only non-test, non-fixture TypeScript sources under `src/sdk/`. */
export function sdkSourceFilesUnder(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === "fixtures" || name === "fixture" || name === "node_modules") continue
        walk(full)
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        files.push(relative(root, full))
      }
    }
  }
  walk(root)
  return files.sort()
}

/** Scan every production TypeScript file under `src/sdk/`, with no exceptions. */
export function scanSdkPortBoundaries(root: string): SdkScanResult {
  const entries = sdkSourceFilesUnder(root).map((file) => ({
    file,
    source: readFileSync(join(root, file), "utf8"),
  }))
  const imports: SdkImportSite[] = []
  const computedDynamicImports: SdkTokenViolation[] = []
  const ambientEscapes: SdkTokenViolation[] = []
  for (const result of scanSourcesWithTypeScript(entries)) {
    imports.push(...result.imports)
    computedDynamicImports.push(...result.computedDynamicImports)
    ambientEscapes.push(...result.ambientEscapes)
  }
  return { imports, computedDynamicImports, ambientEscapes }
}

/** Return only module edges that resolve to forbidden concrete host collaborators. */
export function forbiddenSdkImports(result: SdkScanResult): SdkImportSite[] {
  return result.imports.filter((site) => forbiddenTarget(site.resolved) !== undefined)
}

/** Count the type-only module edges separately for ratchet diagnostics. */
export function typeOnlySdkImportCount(result: SdkScanResult): number {
  return result.imports.filter((site) => site.typeOnly).length
}

/** Render stable, line-oriented diagnostics for every SDK boundary violation. */
export function formatSdkViolations(result: SdkScanResult): string[] {
  return [
    ...forbiddenSdkImports(result).map(
      (site) =>
        `${site.file}:${site.line} ${site.form} ${JSON.stringify(site.specifier)} → ${site.resolved}`,
    ),
    ...result.computedDynamicImports.map(
      (site) => `${site.file}:${site.line} ${site.token}: ${site.detail}`,
    ),
    ...result.ambientEscapes.map(
      (site) => `${site.file}:${site.line} ${site.token}: ${site.detail}`,
    ),
  ].sort()
}

if (
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href &&
  process.argv[2] === SCAN_CHILD_ARGUMENT
) {
  const config = process.argv[3]
  const manifest = process.argv[4]
  if (config === undefined || manifest === undefined)
    throw new Error("scanner child requires config and manifest paths")
  runScanChild(config, manifest)
}
