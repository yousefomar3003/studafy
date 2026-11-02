/**
 * A tenant-scoped composite lookup identifier. Rows in the 3NF schema are keyed by `(id, school_id)`,
 * so a client operation that looks one up must carry the whole block together — the tenant boundary
 * is not an optional secondary argument. Passing both as one value makes it unrepresentable to send
 * an `id` without its `school_id`.
 */
export interface CompositeKey {
  readonly id: string;
  readonly school_id: string;
}

/**
 * Validates a {@link CompositeKey} at a call boundary and returns it unchanged. Throws
 * {@link TypeError} when either half is missing or empty, so a half-populated key fails loudly at the
 * call site rather than silently querying across the tenant boundary.
 */
export function requireCompositeKey(key: CompositeKey): CompositeKey {
  if (
    typeof key.id !== "string" ||
    key.id.length === 0 ||
    typeof key.school_id !== "string" ||
    key.school_id.length === 0
  ) {
    throw new TypeError(
      "A composite lookup requires both `id` and `school_id` together — the tenant boundary is not an optional secondary argument.",
    );
  }
  return key;
}
