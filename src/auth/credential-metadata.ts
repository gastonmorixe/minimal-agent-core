import type { AuthCredentialInfo, AuthSecretBag } from "../llm/provider-plugin.ts"

const FIELDS = [
  { key: "email", label: "email", aliases: ["email", "emailAddress"] },
  { key: "username", label: "username", aliases: ["username", "userName"] },
  { key: "name", label: "name", aliases: ["name", "displayName", "userFullName"] },
  { key: "userId", label: "user id", aliases: ["userId", "user_id"] },
  { key: "accountId", label: "account id", aliases: ["accountId", "account_id", "accountUuid"] },
  {
    key: "organizationId",
    label: "organization id",
    aliases: ["organizationId", "orgId", "organizationUuid"],
  },
  {
    key: "plan",
    label: "plan",
    aliases: ["plan", "planType", "subscriptionTier", "subsTierName"],
  },
  { key: "givenName", label: "given name", aliases: ["givenName"] },
  { key: "familyName", label: "family name", aliases: ["familyName"] },
  { key: "xUserId", label: "x user id", aliases: ["xUserId"] },
  { key: "principalId", label: "principal id", aliases: ["principalId"] },
  { key: "planStatus", label: "plan status", aliases: ["planStatus"] },
  { key: "planProvider", label: "plan provider", aliases: ["planProvider"] },
  { key: "billingPeriodEnd", label: "billing period end", aliases: ["billingPeriodEnd"] },
  { key: "subsTierId", label: "subscription tier id", aliases: ["subsTierId"] },
  { key: "isSubsActive", label: "subscription active", aliases: ["isSubsActive"] },
  { key: "emailVerified", label: "email verified", aliases: ["emailVerified"] },
  { key: "fedramp", label: "fedramp", aliases: ["fedramp"] },
] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

/** Add only known saved identity fields. Provider diagnostics remain authoritative. */
export function mergeCredentialMetadata(
  secrets: AuthSecretBag,
  info: AuthCredentialInfo,
): AuthCredentialInfo {
  const sources = [secrets, record(secrets.account), record(secrets.profile), record(secrets.user)]
  const details = [...(info.details ?? [])]
  const result = { ...info }
  for (const field of FIELDS) {
    // Treat provider alias keys as the same row without changing provider rows.
    if (
      details.some((detail) =>
        field.aliases.some((alias) => alias.toLowerCase() === detail.key.toLowerCase()),
      )
    ) {
      continue
    }
    if (field.key === "accountId" && info.accountId !== undefined) continue
    if (field.key === "organizationId" && info.organizationId !== undefined) continue
    let value: string | undefined
    for (const source of sources) {
      if (!source) continue
      for (const alias of field.aliases) {
        const saved = source[alias]
        if (
          field.key === "isSubsActive" ||
          field.key === "emailVerified" ||
          field.key === "fedramp"
        ) {
          value = typeof saved === "boolean" ? (saved ? "yes" : "no") : undefined
        } else if (field.key === "billingPeriodEnd" && typeof saved === "number") {
          value = Number.isFinite(saved) ? String(saved) : undefined
        } else {
          value = text(saved)
        }
        if (value !== undefined) break
      }
      if (value !== undefined) break
    }
    // A subscription object is read only at its explicit tier field.
    if (field.key === "plan" && value === undefined) {
      value = text(record(secrets.subscription)?.tier)
    }
    if (value === undefined) continue
    if (field.key === "accountId" || field.key === "organizationId") {
      result[field.key] = value
    } else {
      details.push({ key: field.key, label: field.label, value })
    }
  }
  return details.length > 0 ? { ...result, details } : result
}
