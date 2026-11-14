/**
 * Drift guard for the sessions:read data shape.
 *
 * Two copies exist: the host source of truth (`./capabilities.ts`) and the
 * leaf type-only mirror in plugin-api. Each pair below must be assignable in
 * BOTH directions. `Eq` uses non-distributive conditional types (tuple wrap):
 * https://www.typescriptlang.org/docs/handbook/2/conditional-types.html
 * `tsc` (`bun run check`) fails when one side adds, drops or changes a field.
 * The assignability functions at the bottom give a second, readable signal.
 */

import { describe, expect, it } from "bun:test"

import type * as Leaf from "@minimal-agent/core/plugin-api/types/host-capabilities"

import type * as Host from "./capabilities.ts"

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

export type _RecordView = Assert<Eq<Host.RecordView, Leaf.RecordView>>
export type _SearchHit = Assert<Eq<Host.SearchHit, Leaf.SearchHit>>
export type _ToolCallHit = Assert<Eq<Host.ToolCallHit, Leaf.ToolCallHit>>
export type _SessionMetaView = Assert<Eq<Host.SessionMetaView, Leaf.SessionMetaView>>
export type _SessionsReadApi = Assert<Eq<Host.SessionsReadApi, Leaf.SessionsReadApi>>
export type _BodyPart = Assert<Eq<Host.BodyPart, Leaf.BodyPart>>
export type _RecordFacts = Assert<Eq<Host.RecordFacts, Leaf.RecordFacts>>
export type _SessionRecordsView = Assert<Eq<Host.SessionRecordsView, Leaf.SessionRecordsView>>

// Mutual assignability, both directions, for each pair.
function _assignable(
  h: {
    recordView: Host.RecordView
    searchHit: Host.SearchHit
    toolCallHit: Host.ToolCallHit
    metaView: Host.SessionMetaView
    api: Host.SessionsReadApi
    bodyPart: Host.BodyPart
    facts: Host.RecordFacts
    recordsView: Host.SessionRecordsView
  },
  l: {
    recordView: Leaf.RecordView
    searchHit: Leaf.SearchHit
    toolCallHit: Leaf.ToolCallHit
    metaView: Leaf.SessionMetaView
    api: Leaf.SessionsReadApi
    bodyPart: Leaf.BodyPart
    facts: Leaf.RecordFacts
    recordsView: Leaf.SessionRecordsView
  },
): void {
  const toLeaf: typeof l = h
  const toHost: typeof h = l
  void toLeaf
  void toHost
}
void _assignable

describe("plugin-api sessions data shape drift", () => {
  it("is checked at typecheck time (see the Eq assertions above)", () => {
    expect(true).toBe(true)
  })
})
