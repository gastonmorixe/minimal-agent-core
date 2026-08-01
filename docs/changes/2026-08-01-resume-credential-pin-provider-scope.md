# Resume credential pin: provider scope

**Date:** 2026-08-01

## Summary

`--resume` reused `meta.credentialName` even when CLI/config selected a
**different** provider. Credential names are per-provider store keys
(`grok-oauth-2` is not a cursor credential), so startup failed with
`no credentials for provider "cursor"` while cursor was still logged in.

## Behavior

Precedence stays **CLI > config > resume > provider default**.

Resume pin applies only when:

1. `meta.credentialName` is present, and
2. `meta.provider` is absent (legacy) **or** equals the effective selected
   provider.

On provider mismatch, the pin is skipped, auth falls back to the new
provider's default displayName, and boot emits `diag.warn("auth.resume-pin",
…)` (not a raw `console.error`). The scrollback diagnostic sink buffers
during the startup tree and flushes a `⚠ warn` block **below** the banner
after `closeStartupTree()` — so the header never tears, and non-TUI
formats still go through the diagnostic bus (file log + severity sinks)
rather than ad-hoc stderr paints.

Explicit CLI/config pins still fail loudly if missing. Fork writes the
**resolved** credential into the new session meta (unchanged).

## Files

- `src/host/startup/resolve-credential-name.ts` — `peekResumeCredentialPin`,
  provider gate, `ResolveCredentialNameResult.resumePinSkipped`
- `src/host/startup/provider-boot.ts` — thread resume provider; `diag.warn`
  on skip (buffered by scrollback sink)
- `src/index.ts` — peek pin + provider into provider boot
- `src/host/startup/help.ts` — `--credential-name` / `--resume` notes

## Tests

`src/host/startup/resolve-credential-name.test.ts`:

| Case | Expected |
| --- | --- |
| CLI set, resume pin other provider | CLI wins |
| Config set, resume pin other provider | Config wins |
| Same provider resume pin, no CLI/config | Resume pin used |
| Different provider resume pin, no CLI/config | `undefined` + `resumePinSkipped` |
| Resume pin + missing `meta.provider` (legacy) | Pin still used |
| Resume pin blank / absent | empty, no skip |
| `peekResumeCredentialPin` reads both fields | `{ credentialName, providerId }` |
| Peek missing sid / no resume arg | empty, no throw |

`src/host/startup/provider-boot.test.ts`:

| Case | Expected |
| --- | --- |
| Resume pin + different provider | `diag.warn("auth.resume-pin", …)` with structured data; no `console.error` paint of the pin |
| Resume pin + same provider (CLI pin) | no `auth.resume-pin` event |

Fixtures use neutral provider ids (`alpha` / `beta`) so the provider-decoupling
architecture ratchet stays green.
