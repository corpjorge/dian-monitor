/**
 * Text helpers. The DIAN portal writes the same option with slightly different
 * punctuation depending on the branch of the flow ("Cobranzas" vs "Cobranzas.",
 * "Videoatención" vs "Video Atención"), so every comparison goes through
 * `normalize()` instead of a strict equality check.
 */

/** Lowercase, strip accents, collapse whitespace and drop trailing punctuation. */
export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '');
}

/** `innerText`-style normalization: turns `<br>` newlines into single spaces. */
export function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Finds the best match for `wanted` among `candidates`.
 * Tries exact normalized equality first, then prefix, then substring.
 * Returns `undefined` when nothing matches — callers turn that into a
 * descriptive error listing the real options found on screen.
 */
export function findBestMatch<T>(
  candidates: readonly T[],
  wanted: string,
  label: (item: T) => string,
): T | undefined {
  const target = normalize(wanted);
  if (!target) return undefined;

  const exact = candidates.find((c) => normalize(label(c)) === target);
  if (exact) return exact;

  const prefix = candidates.find((c) => normalize(label(c)).startsWith(target));
  if (prefix) return prefix;

  return candidates.find((c) => normalize(label(c)).includes(target));
}

/** Splits a comma-separated env value into trimmed, non-empty entries. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
