#!/usr/bin/env bun
/**
 * Minimal Claude agent — entry point.
 *
 * A research tool for understanding the minimal API surface needed to
 * make authenticated requests to the Anthropic Messages API using OAuth
 * tokens from the Claude Code CLI's macOS Keychain.
 *
 * This script reuses the real CLI's credentials and replicates its exact
 * request format (headers, metadata, system prompt) so responses are
 * indistinguishable from those to the real CLI.
 *
 * Usage:
 *   bun run src/index.ts                    # interactive REPL with default model
 *   bun run src/index.ts --model opus       # use a specific model (prefix match)
 *   bun run src/index.ts --debug            # log full request/response details
 *   bun run src/index.ts --list-models      # show models available to your account
 *   bun run src/index.ts --list-flags       # show beta feature flags with docs
 *   bun run src/index.ts "hello"            # non-interactive: send prompt, print response, exit
 *   bun run src/index.ts --prompt "hello"   # same, explicit flag
 *   echo "hello" | bun run src/index.ts -   # read prompt from stdin
 *   DEBUG=1 bun run src/index.ts            # alternative debug activation
 */

import { getAuth } from "./auth.ts";
import { Agent, runRepl } from "./agent.ts";
import { listModels, checkQuota } from "./client.ts";
import { VERSION, DEFAULT_MODEL, BETA_FLAGS_DETAILED, buildBetaFlags } from "./headers.ts";
import { getSessionId } from "./metadata.ts";
import { Formatter, parseFormatterCommand } from "./formatter.ts";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`minimal-agent v${VERSION}

Usage: bun run src/index.ts [options]

Options:
  --debug             Enable debug logging (or set DEBUG=1)
  --model <id>        Select model (default: ${DEFAULT_MODEL})
  --list-models       Fetch and display available models, then exit
  --list-flags        Show beta feature flags with descriptions
  --prompt <text>     Non-interactive: send prompt, print response, exit
  <text>              Same as --prompt (bare positional argument)
  -                   Read prompt from stdin (for piping)
  --skip-quota        Skip the startup quota check
  --formatter <cmd>   Pipe streamed output through external formatter
                      (e.g. 'mdstream', 'bat --language=md --paging=never')
  --help, -h          Show this help`);
  process.exit(0);
}

if (args.includes("--debug")) {
  process.env.DEBUG = "1";
}

const modelIdx = args.indexOf("--model");
const model =
  modelIdx !== -1 && args[modelIdx + 1]
    ? args[modelIdx + 1]
    : undefined;

const wantListModels = args.includes("--list-models");
const wantListFlags = args.includes("--list-flags");

const formatterIdx = args.indexOf("--formatter");
const formatterCmd =
  formatterIdx !== -1 && args[formatterIdx + 1]
    ? parseFormatterCommand(args[formatterIdx + 1])
    : undefined;

/**
 * Extract a non-interactive prompt from args.
 *
 * Three forms:
 *   --prompt "text"     explicit flag
 *   "text"              bare positional arg (not starting with --)
 *   -                   read from stdin
 */
async function extractPrompt(): Promise<string | null> {
  // --prompt "text"
  const promptIdx = args.indexOf("--prompt");
  if (promptIdx !== -1 && args[promptIdx + 1]) {
    return args[promptIdx + 1];
  }

  // "-" means read from stdin
  if (args.includes("-")) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf-8").trim();
  }

  // Bare positional: any arg that isn't a flag or flag value
  const flagsWithValues = new Set(["--model", "--prompt", "--formatter"]);
  const flagsNoValue = new Set(["--debug", "--list-models", "--list-flags", "--help", "-h", "-", "--skip-quota"]);
  const skipNext = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValues.has(args[i])) {
      skipNext.add(i);
      skipNext.add(i + 1);
    } else if (flagsNoValue.has(args[i])) {
      skipNext.add(i);
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (!skipNext.has(i) && !args[i].startsWith("--")) {
      return args[i];
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error(`minimal-agent v${VERSION} (session: ${getSessionId().slice(0, 8)}...)`);

  const auth = await getAuth();
  console.error(`auth: ${auth.type}${auth.accountUuid ? ` (account: ${auth.accountUuid.slice(0, 8)}...)` : ""}`);

  // --list-flags: show beta feature flags with documentation and exit
  if (wantListFlags) {
    console.log(`\x1b[1mBeta feature flags (anthropic-beta header)\x1b[22m`);
    console.log(`Sent with every Messages API request. Source: cli.pretty.js v${VERSION}\n`);
    for (const flag of BETA_FLAGS_DETAILED) {
      console.log(`  \x1b[36m${flag.id}\x1b[39m`);
      console.log(`    ${flag.description}`);
      console.log(`    \x1b[2msource: ${flag.source}\x1b[22m`);
      console.log(`    \x1b[2mwhen:   ${flag.condition}\x1b[22m`);
      console.log();
    }
    console.log(`${BETA_FLAGS_DETAILED.length} flags total`);
    return;
  }

  // --list-models: fetch available models from the API and exit
  if (wantListModels) {
    console.error("fetching models...\n");
    const models = await listModels(auth);

    // Group models by family prefix (e.g. "claude-opus", "claude-sonnet")
    const families = new Map<string, typeof models>();
    for (const m of models) {
      const family = m.id.replace(/-\d.*$/, "");
      if (!families.has(family)) families.set(family, []);
      families.get(family)!.push(m);
    }

    for (const [family, members] of [...families.entries()].sort()) {
      console.log(`\x1b[1m${family}\x1b[22m`);
      for (const m of members.sort((a, b) => a.id.localeCompare(b.id))) {
        const name = m.display_name ? ` (${m.display_name})` : "";
        const date = m.created_at ? `  \x1b[2m${m.created_at.slice(0, 10)}\x1b[22m` : "";
        console.log(`  ${m.id}${name}${date}`);
      }
    }
    console.log(`\n${models.length} models available`);
    return;
  }

  const selectedModel = model ?? DEFAULT_MODEL;
  console.error(`model: ${selectedModel}`);

  // Quota check — verify account has quota before starting conversation
  // Matches v2.1.91 behavior: cheap haiku request with max_tokens=1
  if (!args.includes("--skip-quota")) {
    const hasQuota = await checkQuota(auth);
    if (!hasQuota) {
      console.error("error: quota check failed. Account may not have quota or token is invalid.");
      process.exit(1);
    }
    console.error("quota: ok");
  }

  const agent = new Agent({ auth, model: selectedModel });

  // Non-interactive mode: send prompt, print response, exit
  const prompt = await extractPrompt();
  if (prompt) {
    const formatter = formatterCmd ? new Formatter(formatterCmd) : null;
    if (formatter) formatter.start();

    try {
      const gen = agent.run(prompt);
      while (true) {
        const { done, value } = await gen.next();
        if (done) break;
        if (formatter) {
          formatter.write(value);
        } else {
          process.stdout.write(value);
        }
      }
    } finally {
      if (formatter) await formatter.end();
    }

    process.stdout.write("\n");
    return;
  }

  // Interactive REPL mode
  await runRepl(agent, { formatterCmd });
}

main().catch((err: Error) => {
  console.error("fatal:", err.message);
  process.exit(1);
});
