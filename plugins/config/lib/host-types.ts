/**
 * Local mirror of the slice of minimal-agent's plugin contract this plugin
 * consumes. Lets the plugin type-check + unit-test in isolation without the
 * pure `lib/` core ever importing host internals. Handlers import the REAL
 * types from `../../../src/plugins/types.ts`; this mirror types the payload
 * shapes that ride the bus (which the host doesn't export as a public type).
 *
 * Same pattern as `ma-slash-menu-plugin/lib/host-types.ts`.
 *
 * @module config/lib/host-types
 */

/** Payload of the `editor.key` broadcast-sync channel. */
export interface EditorKeyPayload {
  key: string
  buffer: string
  cursor: {
    row: number
    col: number
    visualRow: number
    rowsInLogicalLine: number
    totalLines: number
  }
  result: {
    halt?: boolean
    buffer?: string
    cursor?: { row: number; col: number }
  }
}

/** Payload of the `editor.buffer.changed` broadcast-async channel. */
export interface BufferChangedPayload {
  text: string
  cursor: { row: number; col: number }
}
