# HANDOFF-2 — multi-provider LLM layer (resume doc)

**Session:** 1984614f (continued 4efe61e0) · **Branch:** `dev-private` · **2026-05-28**
**Gate:** `bun run check` → **3446 pass / 10 skip / 0 fail**, lint **0 warnings / 0 errors**, typecheck clean.

Deep architecture + file map: `HANDOFF.md` (same dir). Committed changelogs:
`docs/changes/2026-05-28-anthropic-opus-4-8.md` and
`docs/changes/2026-05-28-openai-provider-and-plugin-seam.md`. This doc is the resume entry point.

---

## Commits this session (oldest → newest, 24)

```
1b320dc feat(llm): canonical provider abstraction + Anthropic Opus 4.8
1444dc5 docs: model selection (README) + LLM-layer guide (CLAUDE.md)
24dd0dc feat(llm): OpenAI provider (Chat Completions + Responses)
74de44d refactor(llm): ProviderPlugin contract + builtin-providers barrel
64398bf feat(quota-status): provider-model tag in the footer effort segment
b781d45 docs(changes): OpenAI provider + provider-plugin seam + footer tag
f9a6b9c refactor(llm): extract OpenAI provider to plugins/llm-openai
59f14ba refactor(llm): extract Anthropic provider to plugins/llm-anthropic
6f14ebd feat(llm): provider-plugin discovery (provider.json + early loader)
44203fd feat(llm): wire provider discovery as the registration path
6bc46f4 refactor(llm): drop builtin barrel; tests use provider discovery
54afc93 docs(changes): mark provider-plugin physical extraction as shipped
d023c4d docs(claude): update LLM-layer section for the plugin extraction
600a99a feat(llm-deepseek): cross-plugin reuse demo            (reverted ↓)
412ccfd docs: document the llm-deepseek cross-plugin-reuse demo (reverted ↓)
25367b6 revert: drop unrequested llm-deepseek plugin
5ba594c feat(llm): shared modalityViolations() gating helper
bd527b0 feat(llm): gate multimodal input in validate() (no silent drops)
5b4be0f test(llm): multimodal request-encoding tests (image/file wire shapes)
ca0411d fix(list-models): merge canonical registry; group by provider
2b18a05 feat(llm-openrouter): OpenAI-compatible gateway provider (reuses llm-openai)
4346b28 feat(cli): `providers` + `providers models [id]` subcommands
c5453dd docs: record multimodality, OpenRouter, and the providers CLI grammar
19d2bf2 test(llm-openrouter): live test accepts 402 (no-credits) as success
```
(+ this HANDOFF-2 commit = 25.)

## What works today (done + committed)

- **Providers are PLUGINS.** `plugins/llm-anthropic`, `plugins/llm-openai`, `plugins/llm-openrouter`, each with a `provider.json` (id/entry/export). `src/llm/provider-discovery.ts` scans them, dynamic-imports each `ProviderPlugin`, and registers it; `src/index.ts main()` calls `registerDiscoveredProviders(<repo>/plugins)` + `activateProviderPlugins()` BEFORE model resolution. The agent core names no provider.
- **16 registered models** (anthropic 6 · openai 8 · openrouter 2). `--list-models` merges them with the LIVE Anthropic catalog and groups by provider → ~26 rows. gpt-5.5 dual-surface (responses + `gpt-5.5-chat`).
- **`providers` CLI grammar — DONE (not pending).** `providers` (offline, no auth) lists providers; `providers models [id]` lists/filters models; `--list-models`/`--models` is a deprecated alias. Verified.
- **Multimodal validation — DONE.** `src/llm/modality-check.ts` `modalityViolations()` is wired into both validators; image/audio/file the model doesn't accept → `CapabilityViolation` (no silent drop). Gating + wire-encoding tests across anthropic-messages / openai-chat / openai-responses.
- **OpenRouter cross-plugin demo — DONE + live-verified.** Reuses `llm-openai`'s `buildOpenAIChatBody` + `translateOpenAIChatStream` + `buildOpenAIHeaders` + `validateOpenAIRequest`; only endpoint differs. Live run returned HTTP 402 (= auth accepted, wire correct, account just lacks credits). Gated test passes on text OR 402.
- **Opus 4.8** + footer tag (`anth-4.8:max`).
- **lint — DONE: 0 warnings / 0 errors** (not TBD). typecheck/format/docs/tests all green.

## Pending (do these next)

1. **Surface column in `--list-models`** (queued, NOT implemented — I had it working+green but reverted per "don't implement, just queue"). Exact spec:
   - In `src/commands/list-models.ts`: add `surface?: string` to the `ModelRow` interface.
   - Live Anthropic rows: `surface: "anthropic-messages"`. Registry rows: `surface: entry.surfaceId`.
   - In the print loop, insert between `name` and `date`: `const surface = c.dim((row.surface ?? "").padEnd(18)); console.log(\`    ${id} ${name} ${surface} ${date}\`)`.
   - Note: OpenRouter models report `surfaceId: "openai-chat"` (they share that surface), NOT `openrouter-chat`. Show the real surfaceId. ~4 edits, then `bun run biome:fix` + `bun run check`.

2. **Phase 4-extended — agent loop canonicalization (THE big unlock, HIGH RISK).** `Agent.send`/`Agent.run` still use the legacy `client.sendMessage` (Anthropic-only), so `--model gpt-5.5` is listed/registered but does NOT actually route to OpenAI at runtime through the agent. Migrate the agent transport onto `run()` from `src/llm/`, moving the stream-idle/hard-timeout watchdogs, retry coordinator, 401 keychain-first refresh (multi-process race fix), and observer off `client.ts` into provider-neutral middleware. Guard every step with snapshot tests against `.node-net-dbg`. Do NOT casually edit `client.ts`.

3. **OpenRouter credits** — the account has none, so the live happy-path can't complete (test green via the 402 branch). Add credits to exercise a real completion.

4. **shortCode nit** — `plugins/llm-openai/adapter.ts` uses `shortCode: "oai"`; user wrote `oia`. One-char flip if desired (feeds the footer tag).

5. **Unrelated uncommitted work in the tree** (`src/session-replay*`, `src/session-store*`, `src/metadata.test.ts`, `src/network/http2-transport.ts`, `src/test-utils/fixtures/metadata-user-id-capture.json`) is a SEPARATE epic — not mine, left untouched. Don't sweep it into LLM commits.

## No outstanding gaps in this epic: typecheck, lint (0/0), format, biome, docs, and tests are all green.

## Priming prompt for the next agent (paste verbatim)

> Continue the multi-provider LLM work on branch `dev-private`. Read
> `private/research/2026-05-28-llm-providers/HANDOFF-2.md` first (resume doc),
> then `HANDOFF.md` (architecture + file map) in the same dir. State: providers
> are plugins under `plugins/llm-{anthropic,openai,openrouter}`, discovered via
> `provider.json` + `src/llm/provider-discovery.ts`, registered in `main()`.
> `bun run check` is green (3446 pass / 0 fail, 0 lint warnings). FIRST do the
> small queued task: add a **surface column** to `src/commands/list-models.ts`
> between the name and date columns, reading `ModelEntry.surfaceId` (spec in
> HANDOFF-2 "Pending" #1), `bun run biome:fix`, confirm `bun run check` green,
> atomic commit. THEN, if directed, take on Phase 4-extended (migrate `Agent.run`
> onto the canonical `run()` so `--model gpt-5.5` actually dispatches to OpenAI —
> high risk, do NOT casually touch `client.ts`'s retry/watchdog/401 infra).
> Commit often (atomic, green). Keep `bun run check` at 0 warnings / 0 errors.
> Do NOT commit the unrelated session-replay/metadata/http2 changes already in
> the tree.

(git status + commit-count summary appended by the final commit step.)
