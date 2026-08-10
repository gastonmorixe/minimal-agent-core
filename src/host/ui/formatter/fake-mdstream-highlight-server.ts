export {}

const mode = process.argv[2] ?? "normal"
const encoder = new TextEncoder()

async function writeChunks(text: string, split = false): Promise<void> {
  if (!split) {
    await Bun.write(Bun.stdout, text)
    return
  }

  const bytes = encoder.encode(text)
  const cuts = [1, Math.min(5, bytes.length), Math.min(11, bytes.length), bytes.length]
  let start = 0
  for (const end of cuts) {
    if (end <= start) continue
    await Bun.write(Bun.stdout, bytes.slice(start, end))
    start = end
    await Bun.sleep(2)
  }
}

if (mode === "bad-ready") {
  await writeChunks('{"ready":0}\n')
} else if (mode === "protocol-v2" || mode === "protocol-error" || mode === "protocol-unbalanced") {
  await writeChunks('{"ready":1,"protocol":2,"modes":["raw","diff-wash","unified-diff"]}\n')
} else {
  await writeChunks('{"ready":1}\n', mode === "split")
}

const decoder = new TextDecoder()
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  while (true) {
    const newline = buffer.indexOf("\n")
    if (newline === -1) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    const request = JSON.parse(line) as {
      id: number
      language: string
      code: string
      mode?: string
      colors?: { inserted?: string; deleted?: string }
      diffStyle?: string
    }

    if (mode === "timeout") {
      await Bun.sleep(5_000)
      continue
    }
    if (mode === "exit") process.exit(2)
    if (mode === "malformed") {
      await writeChunks("not-json\n")
      continue
    }
    if (mode === "protocol-error" && request.mode === "unified-diff") {
      await writeChunks(`${JSON.stringify({ id: request.id, error: "unsupported style" })}\n`)
      continue
    }
    if (mode === "protocol-unbalanced" && request.mode === "unified-diff") {
      await writeChunks(
        `${JSON.stringify({ id: request.id, ansi: `\u001b[48;2;1;2;3m${request.code}` })}\n`,
      )
      continue
    }

    const ansi =
      request.mode === "unified-diff"
        ? `DIFF[${request.language}:${request.diffStyle ?? "marker-fg"}:${request.colors?.inserted ?? "default"}:${request.colors?.deleted ?? "default"}:${request.code}]`
        : `ANSI[${request.language}:${request.code}]`
    const response = `${JSON.stringify({ id: request.id, ansi })}\n`
    await writeChunks(response, mode === "split")
  }
}
