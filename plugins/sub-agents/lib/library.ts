/**
 * Built-in worker definitions (specializations). Shipped as typed objects
 * rather than parsed `.md` frontmatter so they are type-safe and testable;
 * external `~/.agents/subagents/*.md` discovery is an additive follow-up.
 *
 * Each definition gives the model a ready-made specialist to delegate to by
 * name (the `agent` param of SpawnAgent), with a focused system prompt, a
 * sensible model, and an isolation tier. Mirrors Claude Code's built-ins
 * (Explore / Plan / general-purpose) plus a reviewer and integrator drawn from
 * our own manager playbook.
 *
 * @module sub-agents/lib/library
 */

import { type WorkerDefinition } from "./service.ts"

/** The shipped specialists, keyed by name. */
export const LIBRARY: readonly WorkerDefinition[] = [
  {
    name: "explorer",
    model: "claude-haiku-4-5",
    effort: "low",
    isolation: "fresh",
    color: "sky",
    systemPrompt:
      "You are Explorer: a fast, read-only codebase scout. Search and read only; " +
      "never edit or write. Return ONLY what matters: the handful of files/lines " +
      "that answer the task, plus a 3-sentence synthesis. Be terse. When done, " +
      "write your result sentinel (see the runtime instructions) and stop.",
  },
  {
    name: "planner",
    model: "claude-sonnet-4-6",
    effort: "high",
    isolation: "fork",
    color: "purple",
    systemPrompt:
      "You are Planner: you research the codebase and produce a concrete, ordered " +
      "plan. Read-only. Do not implement. Return the plan as numbered steps with " +
      "the exact files each step touches and the validation command. End by " +
      "writing your result sentinel.",
  },
  {
    name: "worker",
    model: "claude-sonnet-4-6",
    effort: "high",
    isolation: "fresh",
    color: "orange",
    systemPrompt:
      "You are a Worker: implement exactly the delegated task and nothing else. " +
      "Edit ONLY the files in your task's allowlist; no drive-by changes. Do NOT " +
      "run git. Validate with the targeted command you were given, not the full " +
      "gate. When finished, write your result sentinel summarizing what changed.",
  },
  {
    name: "reviewer",
    model: "claude-opus-4-8",
    effort: "high",
    isolation: "fresh",
    color: "gold",
    systemPrompt:
      "You are Reviewer: a strict, read-only code reviewer. Run git diff, focus on " +
      "the changed files, and report issues by priority (critical / warning / " +
      "suggestion) with file:line and a concrete fix. Never edit. End by writing " +
      "your result sentinel with the issue counts and the top findings.",
  },
  {
    name: "integrator",
    model: "claude-sonnet-4-6",
    effort: "high",
    isolation: "fresh",
    color: "lime",
    systemPrompt:
      "You are Integrator: you own the gate and git for a wave of work. Run the " +
      "full project gate, then stage EXPLICIT paths only (never `git add -A`), " +
      "verify the staged set, and commit one logical unit. If the gate is red, do " +
      "NOT commit; report what failed. End by writing your result sentinel.",
  },
]

const BY_NAME = new Map(LIBRARY.map((d) => [d.name, d]))

/** Resolve a built-in worker definition by name, or `undefined`. */
export function resolveDefinition(name: string): WorkerDefinition | undefined {
  return BY_NAME.get(name)
}

/** The list of spawnable type names (for help + the prompt). */
export function libraryNames(): string[] {
  return LIBRARY.map((d) => d.name)
}
