export interface Theme {
  name: string
  mode: "light" | "dark"
  colors: Record<string, string>
}
export const detectNerdFont = () =>
  !!(process.env.NERD_FONT || process.env.TERM_PROGRAM === "iTerm.app")
export const DARK: Theme = {
  name: "dark",
  mode: "dark",
  colors: {
    primary: "\x1b[38;5;75m",
    rust: "\x1b[38;5;208m",
    text: "\x1b[37m",
    dim: "\x1b[90m",
    success: "\x1b[32m",
    error: "\x1b[31m",
  },
}
export const LIGHT: Theme = {
  ...DARK,
  name: "light",
  mode: "light",
  colors: { ...DARK.colors, text: "\x1b[30m" },
}
