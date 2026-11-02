export interface RovingItem {
  disabled?: boolean;
}

/**
 * Index traversal shared by Tabs and Select: both walk a list with disabled entries, wrap at the
 * ends, and must never land on a disabled item. Kept as pure functions rather than a hook because
 * the two components handle keys very differently (typeahead and open/close for Select, selection
 * modes for Tabs) — only the traversal is common.
 *
 * Returns `from` when no enabled item exists, so callers never have to handle -1.
 */
export function nextEnabledIndex(items: readonly RovingItem[], from: number, step: 1 | -1): number {
  const { length } = items;
  if (length === 0) {
    return from;
  }

  for (let offset = 1; offset <= length; offset += 1) {
    const candidate = (from + step * offset + length * offset) % length;
    // eslint-disable-next-line security/detect-object-injection -- `candidate` is a modulo of the array length, always in bounds
    if (!items[candidate]?.disabled) {
      return candidate;
    }
  }
  return from;
}

export function firstEnabledIndex(items: readonly RovingItem[]): number {
  const index = items.findIndex((item) => !item.disabled);
  return index === -1 ? 0 : index;
}

export function lastEnabledIndex(items: readonly RovingItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    // eslint-disable-next-line security/detect-object-injection -- `index` is a descending loop counter bounded by the array length
    if (!items[index]?.disabled) {
      return index;
    }
  }
  return 0;
}
