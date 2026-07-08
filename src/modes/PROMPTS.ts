export function modeToolRefusalMessage(args: {
  toolName: string
  label: string
  refusalHint?: string
}): string {
  const tail = args.refusalHint ? ` ${args.refusalHint}` : ""
  return `Tool "${args.toolName}" is not permitted in ${args.label} mode.${tail}`
}

export function activeModeStamp(id: string, since: string): string {
  return `<ma::agent::mode-active id="${id}" since="${since}" />`
}

export function modeChangeAttachment(args: { from: string; to: string; at: string }): string {
  return `<ma::agent::mode-change from="${args.from}" to="${args.to}" at="${args.at}" />`
}
