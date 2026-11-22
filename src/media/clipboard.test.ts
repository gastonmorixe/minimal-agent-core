import { describe, expect, it } from "bun:test"

import {
  type BunImageStatics,
  type ClipboardEnv,
  clipboardImage,
  clipboardImageSync,
  readClipboardImage,
} from "./clipboard.ts"

const stub = (s: unknown) => s as BunImageStatics
// On Linux a null native result falls through to wl-paste/xclip, which may exist.
const native = process.platform !== "linux"

describe("clipboardImage (Bun native)", () => {
  it("re-encodes the pasteboard image to PNG before reading bytes", async () => {
    const calls: string[] = []
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const img = {
      png: () => {
        calls.push("png")
        return img
      },
      bytes: async () => {
        calls.push("bytes")
        return png
      },
    }
    expect(await clipboardImage(stub({ fromClipboard: () => img }))).toEqual(png)
    expect(calls).toEqual(["png", "bytes"]) // png() sets the target before bytes()
  })

  it("still reads bytes when the handle has no .png()", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const s = stub({ fromClipboard: () => ({ bytes: async () => bytes }) })
    expect(await clipboardImage(s)).toEqual(bytes)
  })

  it.skipIf(!native)("returns null when the clipboard holds no image", async () => {
    expect(await clipboardImage(stub({ fromClipboard: () => null }))).toBeNull()
  })

  it.skipIf(!native)("returns null (no throw) when fromClipboard throws", async () => {
    const s = stub({
      fromClipboard: () => {
        throw new Error("boom")
      },
    })
    expect(await clipboardImage(s)).toBeNull()
  })

  it.skipIf(!native)("returns null (no throw) when .bytes() rejects", async () => {
    const img = {
      png: () => img,
      bytes: async (): Promise<Uint8Array> => {
        throw new Error("decode failed")
      },
    }
    expect(await clipboardImage(stub({ fromClipboard: () => img }))).toBeNull()
  })

  it.skipIf(!native)("returns null when the runtime has no Bun.Image", async () => {
    expect(await clipboardImage(null)).toBeNull()
  })
})

describe("readClipboardImage (failure reporting)", () => {
  it("returns the bytes and no error on success", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const s = stub({ fromClipboard: () => ({ bytes: async () => bytes }) })
    expect(await readClipboardImage(s)).toEqual({ bytes })
  })

  it.skipIf(!native)("an empty clipboard is not a failure (no error)", async () => {
    const s = stub({ fromClipboard: () => null, hasClipboardImage: () => false })
    expect(await readClipboardImage(s)).toEqual({ bytes: null })
  })

  it.skipIf(!native)("a runtime with no Bun.Image is not a failure", async () => {
    expect(await readClipboardImage(null)).toEqual({ bytes: null })
  })

  it.skipIf(!native)("reports the message when fromClipboard throws", async () => {
    const s = stub({
      fromClipboard: () => {
        throw new Error("pasteboard busy")
      },
    })
    expect(await readClipboardImage(s)).toEqual({ bytes: null, error: "pasteboard busy" })
  })

  it.skipIf(!native)("reports the message when .bytes() rejects", async () => {
    const img = {
      png: () => img,
      bytes: async (): Promise<Uint8Array> => {
        throw new Error("decode failed")
      },
    }
    expect(await readClipboardImage(stub({ fromClipboard: () => img }))).toEqual({
      bytes: null,
      error: "decode failed",
    })
  })

  it.skipIf(!native)("reports zero decoded bytes as an error", async () => {
    const s = stub({ fromClipboard: () => ({ bytes: async () => new Uint8Array() }) })
    const r = await readClipboardImage(s)
    expect(r.bytes).toBeNull()
    expect(r.error).toMatch(/zero bytes/)
  })

  it.skipIf(!native)("reports an image that fromClipboard did not return", async () => {
    const s = stub({ fromClipboard: () => null, hasClipboardImage: () => true })
    const r = await readClipboardImage(s)
    expect(r.bytes).toBeNull()
    expect(r.error).toMatch(/could not be read/)
  })

  it.skipIf(!native)("a throwing hasClipboardImage is not a failure", async () => {
    const s = stub({
      fromClipboard: () => null,
      hasClipboardImage: () => {
        throw new Error("x")
      },
    })
    expect(await readClipboardImage(s)).toEqual({ bytes: null })
  })
})

describe("clipboardImageSync (no pngpaste)", () => {
  it.skipIf(process.platform !== "darwin")("never shells out on macOS: always null", () => {
    expect(clipboardImageSync()).toBeNull()
  })
})

describe("readClipboardImage (Linux helpers)", () => {
  const linux = (installed: string[]): ClipboardEnv => ({
    platform: "linux",
    which: (cmd) => (installed.includes(cmd) ? `/usr/bin/${cmd}` : null),
  })
  const none = stub({ fromClipboard: () => null })

  it("warns when neither wl-paste nor xclip is installed", async () => {
    const r = await readClipboardImage(none, linux([]))
    expect(r.bytes).toBeNull()
    expect(r.error).toMatch(/wl-clipboard.*xclip/)
  })

  it("an installed helper with an empty clipboard is not a failure", async () => {
    // The helper is on PATH but returns nothing: the clipboard is just empty.
    expect(await readClipboardImage(none, linux(["wl-paste"]))).toEqual({ bytes: null })
    expect(await readClipboardImage(none, linux(["xclip"]))).toEqual({ bytes: null })
  })

  it("keeps the native error instead of the missing-helper error", async () => {
    const s = stub({
      fromClipboard: () => {
        throw new Error("pasteboard busy")
      },
    })
    expect((await readClipboardImage(s, linux([]))).error).toBe("pasteboard busy")
  })

  it("never reports a missing helper on macOS or Windows", async () => {
    const none2 = (platform: NodeJS.Platform): ClipboardEnv => ({ platform, which: () => null })
    expect(await readClipboardImage(none, none2("darwin"))).toEqual({ bytes: null })
    expect(await readClipboardImage(none, none2("win32"))).toEqual({ bytes: null })
  })
})
