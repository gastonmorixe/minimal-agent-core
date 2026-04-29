/**
 * Shared diff renderer for the diff-view plugin.
 *
 * Takes a unified diff string and returns an ANSI-colored version:
 * additions green, deletions red, hunk headers cyan, file headers bold.
 * Keeps everything else untouched.
 *
 * Minimal and dependency-free. Not a full patch parser; it just decorates
 * lines by their first-character prefix, which is enough for unified-diff
 * output from `git diff` and friends.
 */

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

export function renderUnifiedDiff(patch: string, title?: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];

  if (title) {
    out.push(`${BOLD}${title}${RESET}`);
    out.push(`${DIM}${"─".repeat(Math.min(title.length + 4, 64))}${RESET}`);
  }

  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      out.push(`${BOLD}${line}${RESET}`);
      continue;
    }
    if (line.startsWith("@@")) {
      out.push(`${CYAN}${line}${RESET}`);
      continue;
    }
    if (line.startsWith("+")) {
      out.push(`${GREEN}${line}${RESET}`);
      continue;
    }
    if (line.startsWith("-")) {
      out.push(`${RED}${line}${RESET}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
