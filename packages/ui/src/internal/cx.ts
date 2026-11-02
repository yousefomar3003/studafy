export type ClassValue = string | false | null | undefined;

/** Joins the truthy class names. The repo has no `clsx`, and this is all we need of one. */
export function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
