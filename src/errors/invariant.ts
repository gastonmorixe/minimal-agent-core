/**
 * Developer-only invariant failure. Carries an identifier and data, no text.
 *
 * @module errors/invariant
 */

import { CoreError } from "./core-error.ts"
import type { JsonValue } from "./types.ts"

/** Thrown by `invariant()`. */
export class InvariantError extends CoreError {
  static readonly kind = "InvariantError"
  declare readonly kind: "InvariantError"
  /** Identifier of the broken invariant, for example `"event_log.offset_in_range"`. */
  readonly invariant: string
  /** Input facts about the failure. */
  readonly data: Readonly<Record<string, JsonValue>>

  constructor(
    invariant: string,
    data: Readonly<Record<string, JsonValue>> = {},
    options?: { cause?: unknown },
  ) {
    super(options)
    this.invariant = invariant
    this.data = data
  }
}

/** Throw `InvariantError` with the identifier `name` and the `data` record. */
export function invariant(name: string, data?: Readonly<Record<string, JsonValue>>): never {
  throw new InvariantError(name, data)
}
