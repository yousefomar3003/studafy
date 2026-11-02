/**
 * The platform's product signal from student imports: which column headers schools bring that no
 * Studafy field reads, counted across schools (docs/modules/student-import-mapping-guide.md
 * "Product signal").
 *
 * Header text and counts only. No cell value is read, no school is named, and a header is shown
 * only once at least MIN_SCHOOLS schools have brought it: a header one school alone uses can say
 * something about that school ("Ahmad's bus notes"). Read the way every cross-school figure is
 * (modules/platform/service.ts): one school's scope armed at a time inside one system transaction.
 */

import { setTenantScope, withSystemTx } from "../../db/tenant-tx";

import type { UnmappedHeaderSignal } from "./schemas";
import type { Database } from "../../db/client";

export const SIGNAL_MIN_SCHOOLS = 3;
const SIGNAL_LIMIT = 200;

/** "Column 4": a blank header cell readCsvSource named, which says nothing about the school's data. */
const GENERATED_HEADER = /^column\d+$/;

export async function unmappedHeaderSignal(
  database: Database,
  requestId?: string,
): Promise<UnmappedHeaderSignal> {
  return withSystemTx(database, async (tx) => {
    const schools = await tx<{ id: string }[]>`SELECT id FROM app.schools ORDER BY id`;
    const byKey = new Map<
      string,
      { schools: number; imports: number; spellings: Map<string, number> }
    >();

    for (const school of schools) {
      await setTenantScope(tx, school.id, requestId);
      const rows = await tx<{ normalized_header: string; header: string; imports: number }[]>`
        SELECT normalized_header, header, count(DISTINCT import_id)::int AS imports
        FROM app.student_import_unmapped_columns
        WHERE school_id = ${school.id}::uuid AND normalized_header <> ''
        GROUP BY normalized_header, header
      `;
      const seenHere = new Set<string>();
      for (const row of rows) {
        if (GENERATED_HEADER.test(row.normalized_header)) continue;
        const entry = byKey.get(row.normalized_header) ?? {
          schools: 0,
          imports: 0,
          spellings: new Map<string, number>(),
        };
        if (!seenHere.has(row.normalized_header)) {
          entry.schools++;
          seenHere.add(row.normalized_header);
        }
        entry.imports += row.imports;
        // A spelling counts once per school, so one school's many imports cannot pick the label.
        entry.spellings.set(row.header, (entry.spellings.get(row.header) ?? 0) + 1);
        byKey.set(row.normalized_header, entry);
      }
    }

    const headers = [...byKey.entries()]
      .filter(([, entry]) => entry.schools >= SIGNAL_MIN_SCHOOLS)
      .map(([normalized, entry]) => ({
        normalized_header: normalized,
        header: [...entry.spellings.entries()].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0]![0],
        schools: entry.schools,
        imports: entry.imports,
      }))
      .sort(
        (a, b) =>
          b.schools - a.schools ||
          b.imports - a.imports ||
          a.normalized_header.localeCompare(b.normalized_header),
      )
      .slice(0, SIGNAL_LIMIT);

    return { min_schools: SIGNAL_MIN_SCHOOLS, headers };
  });
}
