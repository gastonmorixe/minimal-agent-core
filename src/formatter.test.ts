import { describe, expect, it } from "bun:test"
import { Formatter } from "./formatter.ts"

class FakeOutput {
  readonly chunks: string[] = []
  columns?: number
  rows?: number

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }

  text(): string {
    return this.chunks.join("")
  }
}

describe("Formatter", () => {
  it("strips a leading formatter newline from the first stdout chunk", async () => {
    const output = new FakeOutput()
    const formatter = new Formatter(["bun", "-e", 'process.stdout.write("\\nHELLO")'], output)

    formatter.start()
    await formatter.end()

    expect(output.text()).toBe("HELLO")
  })

  it("preserves formatter output when the first chunk does not start with a newline", async () => {
    const output = new FakeOutput()
    const formatter = new Formatter(["bun", "-e", 'process.stdout.write("HELLO")'], output)

    formatter.start()
    await formatter.end()

    expect(output.text()).toBe("HELLO")
  })

  it("passes output dimensions to formatter subprocesses", async () => {
    const output = new FakeOutput()
    output.columns = 60
    output.rows = 17
    const formatter = new Formatter(
      ["bun", "-e", "process.stdout.write(`${process.env.COLUMNS}:${process.env.LINES}`)"],
      output,
    )

    formatter.start()
    await formatter.end()

    expect(output.text()).toBe("60:17")
  })

  it("routes formatter stderr through the configured output sink", async () => {
    const output = new FakeOutput()
    const formatter = new Formatter(
      ["bun", "-e", "process.stderr.write('formatter warning')"],
      output,
    )

    formatter.start()
    await formatter.end()

    expect(output.text()).toBe("formatter warning")
  })

  it("keeps split ANSI sequences intact across formatter stdout chunks", async () => {
    const output = new FakeOutput()
    const formatter = new Formatter(
      [
        "bun",
        "-e",
        "process.stdout.write('\\x1b[31'); setTimeout(() => process.stdout.write('mred\\x1b[0m'), 1)",
      ],
      output,
    )

    formatter.start()
    await formatter.end()

    expect(output.chunks).not.toContain("\x1b[31")
    expect(output.text()).toBe("\x1b[31mred\x1b[0m")
  })
})
