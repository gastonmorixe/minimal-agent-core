/** Reads the user's login shell from `$SHELL` (default `/bin/bash`) and returns its path, basename, and `-c` invocation args. */
export function detectShell() {
  const s = process.env.SHELL || "/bin/bash"
  return { shell: s, name: s.split("/").pop()!, args: ["-c"] }
}
/** One-line system-prompt hint telling the model which shell the user runs so it can adapt command syntax. */
export function shellPrompt() {
  const { name, shell } = detectShell()
  return "User shell: " + name + " (" + shell + "). Adapt commands."
}
