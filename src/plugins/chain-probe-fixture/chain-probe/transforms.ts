const log = (): string[] => {
  const g = globalThis as unknown as { __chainProbeLog?: string[] }
  g.__chainProbeLog ??= []
  return g.__chainProbeLog
}
const stage = (phase: string) => ({
  phase,
  order: 0,
  transform: <S extends { kind?: string }>(s: S): S => {
    log().push(phase)
    return phase === "stamp" ? { ...s, kind: "probe-mark" } : s
  },
})
export default ["clamp", "pre-outcome", "post-blob", "final", "stamp"].map(stage)
