import { basename, extname } from "node:path"

/** Inputs available when inferring a tool-output file's highlighting language. */
export interface FileLanguageInput {
  /** File path or bare filename reported by the tool. */
  path?: string | null
  /** File content. Only the bounded first line is inspected. */
  content?: string | null
}

/** Canonical syntax tokens accepted by mdstream/syntect. */
export type FileLanguage =
  | "bash"
  | "bat"
  | "c"
  | "clojure"
  | "cmake"
  | "cpp"
  | "csharp"
  | "css"
  | "dart"
  | "diff"
  | "dockerfile"
  | "elixir"
  | "elm"
  | "erlang"
  | "fish"
  | "fsharp"
  | "go"
  | "graphql"
  | "groovy"
  | "haskell"
  | "html"
  | "ini"
  | "java"
  | "javascript"
  | "json"
  | "julia"
  | "kotlin"
  | "lua"
  | "makefile"
  | "markdown"
  | "nginx"
  | "nix"
  | "objective-c"
  | "ocaml"
  | "perl"
  | "php"
  | "powershell"
  | "protobuf"
  | "python"
  | "r"
  | "ruby"
  | "rust"
  | "scala"
  | "sql"
  | "swift"
  | "terraform"
  | "toml"
  | "typescript"
  | "viml"
  | "vue"
  | "xml"
  | "yaml"
  | "zig"

const MAX_FIRST_LINE_CODE_UNITS = 512

const EXACT_FILENAMES: Readonly<Record<string, FileLanguage | null>> = {
  ".bash_profile": "bash",
  ".bashrc": "bash",
  ".env": "bash",
  ".gitattributes": null,
  ".gitignore": null,
  ".npmrc": "ini",
  ".profile": "bash",
  ".vimrc": "viml",
  ".zprofile": "bash",
  ".zshrc": "bash",
  brewfile: "ruby",
  "cargo.lock": "toml",
  "cargo.toml": "toml",
  "cmakelists.txt": "cmake",
  "compose.yaml": "yaml",
  "compose.yml": "yaml",
  "deno.json": "json",
  "deno.jsonc": "json",
  "docker-compose.yaml": "yaml",
  "docker-compose.yml": "yaml",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  "go.mod": "go",
  "go.sum": null,
  justfile: "makefile",
  license: null,
  "license.txt": null,
  makefile: "makefile",
  "nginx.conf": "nginx",
  "package-lock.json": "json",
  "package.json": "json",
  "pnpm-lock.yaml": "yaml",
  procfile: "bash",
  readme: null,
  "readme.md": "markdown",
  "readme.txt": null,
  rakefile: "ruby",
  "tsconfig.json": "json",
  "vite.config.js": "javascript",
  "vite.config.mjs": "javascript",
  "vite.config.ts": "typescript",
  "vitest.config.js": "javascript",
  "vitest.config.mjs": "javascript",
  "vitest.config.ts": "typescript",
}

const EXTENSIONS: Readonly<Record<string, FileLanguage | null>> = {
  ".bat": "bat",
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cmake": "cmake",
  ".conf": null,
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".csv": null,
  ".cts": "typescript",
  ".dart": "dart",
  ".diff": "diff",
  ".eex": "elixir",
  ".elm": "elm",
  ".erl": "erlang",
  ".ex": "elixir",
  ".exs": "elixir",
  ".fish": "fish",
  ".fs": "fsharp",
  ".fsx": "fsharp",
  ".go": "go",
  ".gql": "graphql",
  ".graphql": "graphql",
  ".groovy": "groovy",
  ".h": "c",
  ".hpp": "cpp",
  ".hs": "haskell",
  ".htm": "html",
  ".html": "html",
  ".ini": "ini",
  ".java": "java",
  ".jl": "julia",
  ".js": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".log": null,
  ".lua": "lua",
  ".md": "markdown",
  ".mdx": "markdown",
  ".mjs": "javascript",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".mm": "objective-c",
  ".mts": "typescript",
  ".nix": "nix",
  ".patch": "diff",
  ".php": "php",
  ".pl": "perl",
  ".pm": "perl",
  ".proto": "protobuf",
  ".ps1": "powershell",
  ".py": "python",
  ".pyw": "python",
  ".r": "r",
  ".rb": "ruby",
  ".rs": "rust",
  ".rst": null,
  ".scala": "scala",
  ".scss": "css",
  ".sh": "bash",
  ".sql": "sql",
  ".swift": "swift",
  ".tf": "terraform",
  ".tfvars": "terraform",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsv": null,
  ".tsx": "typescript",
  ".txt": null,
  ".vim": "viml",
  ".vue": "vue",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zig": "zig",
}

const INTERPRETERS: Readonly<Record<string, FileLanguage>> = {
  ash: "bash",
  awk: "bash",
  bash: "bash",
  bun: "typescript",
  cmd: "bat",
  dash: "bash",
  deno: "typescript",
  elixir: "elixir",
  escript: "erlang",
  fish: "fish",
  groovy: "groovy",
  julia: "julia",
  ksh: "bash",
  lua: "lua",
  node: "javascript",
  nodejs: "javascript",
  perl: "perl",
  php: "php",
  pwsh: "powershell",
  python: "python",
  python2: "python",
  python3: "python",
  rscript: "r",
  ruby: "ruby",
  sh: "bash",
  swift: "swift",
  zsh: "bash",
}

/**
 * Resolve a source language without guessing from general prose or code shape.
 *
 * Evidence is deliberately narrow and ordered: exact filename, extension, then
 * one bounded first line for a shebang or an unambiguous file signature.
 */
export function resolveFileLanguage(input: FileLanguageInput): FileLanguage | null {
  const path = input.path?.trim()
  if (path) {
    const filename = portableBasename(path).toLowerCase()
    if (Object.hasOwn(EXACT_FILENAMES, filename)) return EXACT_FILENAMES[filename] ?? null

    const extension = extname(filename).toLowerCase()
    if (Object.hasOwn(EXTENSIONS, extension)) return EXTENSIONS[extension] ?? null
  }

  const firstLine = boundedFirstLine(input.content)
  if (!firstLine) return null

  const shebangLanguage = resolveShebang(firstLine)
  if (shebangLanguage) return shebangLanguage

  const trimmed = firstLine.trimStart().toLowerCase()
  if (trimmed.startsWith("<?xml")) return "xml"
  if (trimmed.startsWith("<?php")) return "php"
  if (trimmed === "@echo off" || trimmed.startsWith("@echo off ")) return "bat"

  return null
}

function portableBasename(path: string): string {
  return basename(path.replaceAll("\\", "/"))
}

function boundedFirstLine(content: string | null | undefined): string {
  if (!content) return ""
  const sample = content.slice(0, MAX_FIRST_LINE_CODE_UNITS)
  const newline = sample.search(/[\r\n]/)
  return newline === -1 ? sample : sample.slice(0, newline)
}

function resolveShebang(firstLine: string): FileLanguage | null {
  if (!firstLine.startsWith("#!")) return null

  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null

  let executable = portableBasename(words[0]!).toLowerCase()
  if (executable === "env") {
    let index = 1
    if (words[index] === "-s" || words[index] === "-S") index += 1
    while (words[index]?.includes("=")) index += 1
    executable = portableBasename(words[index] ?? "").toLowerCase()
  }

  return INTERPRETERS[executable] ?? null
}
