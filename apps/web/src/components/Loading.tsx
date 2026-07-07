/** Accessible loading indicator used as the Suspense fallback for lazy route groups. */
export function Loading() {
  return (
    <p role="status" aria-live="polite">
      Loading…
    </p>
  );
}
