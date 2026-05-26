import { describe, expect, test } from "bun:test"

import {
  isNonInteractive,
  resolveInitialModeId,
  resolveShowHeader,
} from "./non-interactive-defaults.ts"

const NO_ENV = {} as const
const NO_CFG = {} as const

describe("isNonInteractive", () => {
  test("empty argv → interactive", () => {
    expect(isNonInteractive([])).toBe(false)
  })
  test("--prompt <text> → non-interactive", () => {
    expect(isNonInteractive(["--prompt", "hi"])).toBe(true)
  })
  test("`-` stdin sentinel → non-interactive", () => {
    expect(isNonInteractive(["-"])).toBe(true)
  })
  test("bare positional → non-interactive", () => {
    expect(isNonInteractive(["do the thing"])).toBe(true)
  })
  test("flag-with-value does not count as bare positional", () => {
    expect(isNonInteractive(["--model", "claude-opus-4-7"])).toBe(false)
  })
})

describe("resolveShowHeader", () => {
  test("default: hidden in non-interactive", () => {
    expect(resolveShowHeader({ args: ["--prompt", "hi"], env: NO_ENV, config: NO_CFG })).toBe(false)
  })
  test("default: shown in interactive", () => {
    expect(resolveShowHeader({ args: [], env: NO_ENV, config: NO_CFG })).toBe(true)
  })
  test("--no-header beats everything", () => {
    expect(
      resolveShowHeader({
        args: ["--no-header"],
        env: { HEADER: "1" },
        config: { header: true },
      }),
    ).toBe(false)
  })
  test("--header beats env and config", () => {
    expect(
      resolveShowHeader({
        args: ["--header", "--prompt", "hi"],
        env: { HEADER: "0" },
        config: { header: false },
      }),
    ).toBe(true)
  })
  test("env beats config", () => {
    expect(
      resolveShowHeader({
        args: ["--prompt", "hi"],
        env: { HEADER: "1" },
        config: { header: false },
      }),
    ).toBe(true)
    expect(
      resolveShowHeader({
        args: [],
        env: { HEADER: "0" },
        config: { header: true },
      }),
    ).toBe(false)
  })
  test("config beats default", () => {
    expect(
      resolveShowHeader({
        args: ["--prompt", "hi"],
        env: NO_ENV,
        config: { header: true },
      }),
    ).toBe(true)
    expect(resolveShowHeader({ args: [], env: NO_ENV, config: { header: false } })).toBe(false)
  })
  test("env: accepts true/false strings", () => {
    expect(resolveShowHeader({ args: ["x"], env: { HEADER: "true" }, config: NO_CFG })).toBe(true)
    expect(resolveShowHeader({ args: [], env: { HEADER: "false" }, config: NO_CFG })).toBe(false)
  })
  test("env: garbage value falls through to next layer", () => {
    expect(
      resolveShowHeader({
        args: ["--prompt", "hi"],
        env: { HEADER: "yes" },
        config: { header: true },
      }),
    ).toBe(true)
  })
})

describe("resolveInitialModeId", () => {
  test("default: ask in non-interactive", () => {
    expect(
      resolveInitialModeId({ args: ["--prompt", "hi"], env: NO_ENV, config: NO_CFG }, null),
    ).toBe("ask")
  })
  test("default: plugin default in interactive", () => {
    expect(resolveInitialModeId({ args: [], env: NO_ENV, config: NO_CFG }, null)).toBe(null)
    expect(resolveInitialModeId({ args: [], env: NO_ENV, config: NO_CFG }, "plan")).toBe("plan")
  })
  test("--mode beats everything", () => {
    expect(
      resolveInitialModeId(
        {
          args: ["--mode", "plan", "--prompt", "hi"],
          env: { MODE: "ask" },
          config: { mode: "ask" },
        },
        null,
      ),
    ).toBe("plan")
  })
  test("--mode=value form", () => {
    expect(
      resolveInitialModeId({ args: ["--mode=plan", "hello"], env: NO_ENV, config: NO_CFG }, null),
    ).toBe("plan")
  })
  test("--mode none clears default", () => {
    expect(
      resolveInitialModeId(
        { args: ["--mode", "none", "--prompt", "hi"], env: NO_ENV, config: NO_CFG },
        null,
      ),
    ).toBe(null)
  })
  test("env beats config", () => {
    expect(
      resolveInitialModeId({ args: [], env: { MODE: "plan" }, config: { mode: "ask" } }, null),
    ).toBe("plan")
  })
  test("env: none sentinel", () => {
    expect(
      resolveInitialModeId(
        { args: ["--prompt", "hi"], env: { MODE: "none" }, config: NO_CFG },
        null,
      ),
    ).toBe(null)
  })
  test("config beats default", () => {
    expect(
      resolveInitialModeId(
        { args: ["--prompt", "hi"], env: NO_ENV, config: { mode: "plan" } },
        null,
      ),
    ).toBe("plan")
  })
  test("config: none sentinel", () => {
    expect(
      resolveInitialModeId(
        { args: ["--prompt", "hi"], env: NO_ENV, config: { mode: "none" } },
        null,
      ),
    ).toBe(null)
  })
})
