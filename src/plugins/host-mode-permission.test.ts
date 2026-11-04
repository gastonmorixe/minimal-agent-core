import { describe, expect, test } from "bun:test"

import { HOST_MODE_STDIO_PERMISSION, hasHostModeStdio } from "./host-mode-permission.ts"

describe("hasHostModeStdio", () => {
  test("the permission string is hostMode:stdio", () => {
    expect(HOST_MODE_STDIO_PERMISSION).toBe("hostMode:stdio")
  })

  test("true only when permissions lists hostMode:stdio", () => {
    expect(hasHostModeStdio({ permissions: ["hostMode:stdio"] })).toBe(true)
    expect(hasHostModeStdio({ permissions: ["fs:read", "hostMode:stdio"] })).toBe(true)
    expect(hasHostModeStdio({ permissions: ["fs:read"] })).toBe(false)
    expect(hasHostModeStdio({ permissions: [] })).toBe(false)
    expect(hasHostModeStdio({})).toBe(false)
  })

  test("no prefix or case match", () => {
    expect(hasHostModeStdio({ permissions: ["hostMode"] })).toBe(false)
    expect(hasHostModeStdio({ permissions: ["hostmode:stdio"] })).toBe(false)
    expect(hasHostModeStdio({ permissions: ["hostMode:*"] })).toBe(false)
  })
})
