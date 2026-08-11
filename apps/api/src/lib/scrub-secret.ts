/**
 * Replace every literal occurrence of a secret, at any depth, with a marker.
 *
 * Shared by the ERPNext client (ST-119) and the Anthropic LLM provider (ST-164): both talk to a
 * provider that echoes request context into some error bodies, so redacting known-sensitive key
 * names is not enough — the credential's literal value must be scrubbed too.
 */

export function scrubSecret(value: unknown, secret: string): unknown {
  if (secret.length === 0) return value;
  if (typeof value === "string") {
    return value.includes(secret) ? value.split(secret).join("[REDACTED]") : value;
  }
  if (Array.isArray(value)) return value.map((item) => scrubSecret(item, secret));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubSecret(nested, secret);
    }
    return out;
  }
  return value;
}
