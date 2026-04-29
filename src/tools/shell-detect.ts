export function detectShell() {
  const s = process.env.SHELL || "/bin/bash"
  return { shell: s, name: s.split("/").pop()!, args: ["-c"] }
}
export function shellPrompt() {
  const { name, shell } = detectShell()
  return "User shell: " + name + " (" + shell + "). Adapt commands."
}
