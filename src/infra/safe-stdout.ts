function isNodeError(v: unknown): v is NodeJS.ErrnoException {
  return typeof v === "object" && v !== null
}

export function isBrokenPipeError(err: unknown): boolean {
  return isNodeError(err) && err.code === "EPIPE"
}

/**
 * Write a chunk to stdout while treating EPIPE as normal downstream-close.
 */
export async function writeStdoutSafely(chunk: string): Promise<"written" | "broken-pipe"> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (status: "written" | "broken-pipe") => {
      if (settled) return
      settled = true
      process.stdout.off("error", onError)
      resolve(status)
    }
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      process.stdout.off("error", onError)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const onError = (err: unknown) => {
      if (isBrokenPipeError(err)) {
        finish("broken-pipe")
        return
      }
      fail(err)
    }

    process.stdout.on("error", onError)
    try {
      process.stdout.write(chunk, (err?: Error | null) => {
        if (err) {
          if (isBrokenPipeError(err)) {
            finish("broken-pipe")
            return
          }
          fail(err)
          return
        }
        finish("written")
      })
    } catch (err) {
      if (isBrokenPipeError(err)) {
        finish("broken-pipe")
        return
      }
      fail(err)
    }
  })
}
