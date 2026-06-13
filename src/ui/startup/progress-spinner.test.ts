import { describe, expect, it } from "bun:test"

import { STARTUP_PIPE, startStartupProgressSpinner } from "./progress-spinner.ts"

class CaptureStream {
  isTTY = true
  #chunks: string[] = []

  write(chunk: string): void {
    this.#chunks.push(chunk)
  }

  text(): string {
    return this.#chunks.join("")
  }
}

describe("startStartupProgressSpinner", () => {
  it("renders shared startup spinner chrome and a final success row", () => {
    const stream = new CaptureStream()
    const spinner = startStartupProgressSpinner("fetching thing", { stream })

    spinner.setPhase("installing thing")
    spinner.done("thing installed")

    const out = stream.text()
    expect(out).toContain(`${STARTUP_PIPE}\n`)
    expect(out).toContain("fetching thing")
    expect(out).toContain("thing installed")
    expect(out).toContain("\x1b[2K")
    expect(out).toContain("✔")
  })

  it("renders a final failure row", () => {
    const stream = new CaptureStream()
    const spinner = startStartupProgressSpinner("fetching thing", { stream })

    spinner.fail("thing unavailable")

    const out = stream.text()
    expect(out).toContain("thing unavailable")
    expect(out).toContain("✗")
  })

  it("is silent when disabled", () => {
    const stream = new CaptureStream()
    const spinner = startStartupProgressSpinner("fetching thing", { enabled: false, stream })

    spinner.setPhase("installing thing")
    spinner.done("thing installed")

    expect(stream.text()).toBe("")
  })

  it("is silent for non-TTY streams", () => {
    const stream = new CaptureStream()
    stream.isTTY = false
    const spinner = startStartupProgressSpinner("fetching thing", { stream })

    spinner.fail("thing unavailable")

    expect(stream.text()).toBe("")
  })
})
