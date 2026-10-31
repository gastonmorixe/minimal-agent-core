/**
 * Public re-export of src/plugins/host/providers/sessions-read.ts — the
 * real `sessions:read` capability implementation (`createSessionsReadApi`
 * and its window/record-view helpers), needed by `ma dump`
 * (`commands/dump.ts`) (S34 exports-gap decision, Phase 0 / Bucket C).
 *
 * @module host-public/sessions-read
 */
export * from "../plugins/host/providers/sessions-read.ts"
