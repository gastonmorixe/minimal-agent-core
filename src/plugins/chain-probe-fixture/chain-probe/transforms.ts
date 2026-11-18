const log = (): string[] => {
  const g = globalThis as unknown as { __chainProbeLog?: string[] }
  g.__chainProbeLog ??= []
  return g.__chainProbeLog
}
const stage = (phase: string) => ({
  phase,
  order: 0,
  transform: <S extends { kind?: string }>(s: S, ctx?: { signal?: unknown }): S => {
    log().push(`${phase}:${ctx?.signal instanceof AbortSignal}`)
    return phase === "stamp" ? { ...s, kind: "probe-mark" } : s
  },
})
export default ["clamp", "pre-outcome", "post-blob", "final", "stamp"].map(stage)
