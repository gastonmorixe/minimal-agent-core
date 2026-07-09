/** Returns the refusal message shown when a tool is not permitted in the active mode. */
export function modeToolRefusalMessage(args: {
  toolName: string
  label: string
  refusalHint?: string
}): string {
  const tail = args.refusalHint ? ` ${args.refusalHint}` : ""
  return `Tool "${args.toolName}" is not permitted in ${args.label} mode.${tail}`
}

/** Returns the mode-active stamp appended to tool results for the current mode. */
export function activeModeStamp(id: string, since: string): string {
  return `<ma::agent::mode-active id="${id}" since="${since}" />`
}

/** Returns the mode-change attachment marking a transition between modes. */
export function modeChangeAttachment(args: { from: string; to: string; at: string }): string {
  return `<ma::agent::mode-change from="${args.from}" to="${args.to}" at="${args.at}" />`
}
