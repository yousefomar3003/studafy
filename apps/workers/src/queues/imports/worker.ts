import postgres from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImportRow {
  admission_number: string;
  email: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  status: string;
  parent_email: string | null;
  parent_relationship: string | null;
}

interface ImportSummary {
  students_created: number;
  students_skipped: number;
  parents_created: number;
  parents_linked: number;
}

interface ImportJobData {
  importId: string;
  schoolId: string;
}

const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Process a confirmed student import job.
 *
 * Called by the BullMQ IMPORTS worker. Reads rows from student_imports.rows_data,
 * creates users + students + parent links in batches, and writes the summary back.
 *
 * Idempotency: existing emails and admission numbers are skipped (not errored),
 * so re-running a completed import is a safe no-op.
 */
export async function processStudentImport(
  data: ImportJobData,
  databaseUrl: string,
): Promise<ImportSummary> {
  const sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });

  try {
    // Mark as processing.
    await sql`
      UPDATE app.student_imports
      SET status = 'processing'::app.import_status, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${data.importId}::uuid AND school_id = ${data.schoolId}
    `;

    // Fetch the rows data.
    const [importRow] = await sql<{ rows_data: ImportRow[] }[]>`
      SELECT rows_data FROM app.student_imports
      WHERE id = ${data.importId}::uuid AND school_id = ${data.schoolId}
    `;

    if (!importRow) {
      throw new Error(`Import ${data.importId} not found`);
    }

    const rows = importRow.rows_data;
    const summary: ImportSummary = {
      students_created: 0,
      students_skipped: 0,
      parents_created: 0,
      parents_linked: 0,
    };

    // Process in batches within separate transactions.
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await processBatch(sql, data.schoolId, batch, summary);
    }

    // Write summary and mark completed.
    await sql`
      UPDATE app.student_imports
      SET status = 'completed'::app.import_status,
          summary = ${JSON.stringify(summary)}::jsonb,
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${data.importId}::uuid AND school_id = ${data.schoolId}
    `;

    return summary;
  } catch (error) {
    // Mark as failed.
    await sql`
      UPDATE app.student_imports
      SET status = 'failed'::app.import_status, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${data.importId}::uuid AND school_id = ${data.schoolId}
    `.catch(() => {
      // Best-effort status update on failure; ignore errors from the status write itself.
    });

    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

async function processBatch(
  sql: postgres.Sql,
  schoolId: string,
  rows: ImportRow[],
  summary: ImportSummary,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true)
    `;

    for (const row of rows) {
      await processRow(tx, schoolId, row, summary);
    }
  });
}

async function processRow(
  tx: postgres.TransactionSql,
  schoolId: string,
  row: ImportRow,
  summary: ImportSummary,
): Promise<void> {
  const normalizedEmail = row.email.toLowerCase().trim();
  const normalizedAdmission = row.admission_number.toLowerCase().trim();

  // Check if student already exists (idempotency).
  const [existingStudent] = await tx<{ id: string }[]>`
    SELECT id FROM app.students
    WHERE school_id = ${schoolId}
      AND normalized_admission_number = ${normalizedAdmission}
    LIMIT 1
  `;

  if (existingStudent) {
    summary.students_skipped++;
    // Still try to link parent if needed.
    if (row.parent_email && row.parent_relationship) {
      await linkParentByEmail(
        tx,
        schoolId,
        existingStudent.id,
        row.parent_email,
        row.parent_relationship,
        summary,
      );
    }
    return;
  }

  // Check if user with this email already exists.
  const [existingUser] = await tx<{ id: string }[]>`
    SELECT id FROM app.users
    WHERE school_id = ${schoolId} AND normalized_email = ${normalizedEmail}
    LIMIT 1
  `;

  let userId: string;

  if (existingUser) {
    userId = existingUser.id;
  } else {
    // Create user.
    const [newUser] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (
        ${schoolId},
        ${row.email},
        ${normalizedEmail},
        ${row.first_name || row.last_name},
        'active'::app.user_status
      )
      ON CONFLICT (school_id, normalized_email) DO UPDATE SET
        display_name = EXCLUDED.display_name
      RETURNING id
    `;
    userId = newUser!.id;

    // Assign STUDENT role.
    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${schoolId}, ${userId}, 'STUDENT'::app.user_role)
      ON CONFLICT (school_id, user_id, role) DO NOTHING
    `;
  }

  // Create student profile.
  const [student] = await tx<{ id: string }[]>`
    INSERT INTO app.students (
      school_id, user_id, admission_number, first_name, middle_name,
      last_name, preferred_name, date_of_birth, admission_date, status
    ) VALUES (
      ${schoolId},
      ${userId},
      ${row.admission_number},
      ${row.first_name},
      ${row.middle_name ?? null},
      ${row.last_name},
      ${row.preferred_name ?? null},
      ${row.date_of_birth ?? null}::date,
      CURRENT_DATE,
      ${row.status}::app.student_status
    )
    ON CONFLICT (school_id, normalized_admission_number) DO NOTHING
    RETURNING id
  `;

  if (!student) {
    // Race condition: another row or concurrent import created this student.
    summary.students_skipped++;
    return;
  }

  summary.students_created++;

  // Link parent if provided.
  if (row.parent_email && row.parent_relationship) {
    await linkParentByEmail(
      tx,
      schoolId,
      student.id,
      row.parent_email,
      row.parent_relationship,
      summary,
    );
  }
}

async function linkParentByEmail(
  tx: postgres.TransactionSql,
  schoolId: string,
  studentId: string,
  parentEmail: string,
  relationship: string,
  summary: ImportSummary,
): Promise<void> {
  const normalizedParentEmail = parentEmail.toLowerCase().trim();

  // Find or create parent user.
  const [existingParent] = await tx<{ id: string }[]>`
    SELECT id FROM app.users
    WHERE school_id = ${schoolId} AND normalized_email = ${normalizedParentEmail}
    LIMIT 1
  `;

  let parentUserId: string;

  if (existingParent) {
    parentUserId = existingParent.id;
  } else {
    const [newParent] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (
        ${schoolId},
        ${parentEmail},
        ${normalizedParentEmail},
        ${parentEmail},
        'active'::app.user_status
      )
      ON CONFLICT (school_id, normalized_email) DO UPDATE SET
        display_name = EXCLUDED.display_name
      RETURNING id
    `;
    parentUserId = newParent!.id;
    summary.parents_created++;

    // Assign PARENT role.
    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (${schoolId}, ${parentUserId}, 'PARENT'::app.user_role)
      ON CONFLICT (school_id, user_id, role) DO NOTHING
    `;
  }

  // Create parent-child link (idempotent).
  const [existingLink] = await tx<{ parent_user_id: string }[]>`
    SELECT parent_user_id FROM app.parent_child_links
    WHERE school_id = ${schoolId}
      AND parent_user_id = ${parentUserId}::uuid
      AND student_id = ${studentId}::uuid
    LIMIT 1
  `;

  if (!existingLink) {
    const [existingFamily] = await tx<{ id: string }[]>`
      SELECT id
      FROM app.families
      WHERE school_id = ${schoolId}
        AND primary_parent_user_id = ${parentUserId}::uuid
      ORDER BY created_at, id
      LIMIT 1
    `;
    const familyId =
      existingFamily?.id ??
      (
        await tx<{ id: string }[]>`
          INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
          VALUES (${schoolId}, left(${parentEmail}, 200), ${parentUserId}::uuid)
          RETURNING id
        `
      )[0]!.id;

    await tx`
      INSERT INTO app.parent_child_links
        (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (
        ${schoolId},
        ${familyId}::uuid,
        ${parentUserId}::uuid,
        ${studentId}::uuid,
        ${relationship}::app.parent_relationship
      )
      ON CONFLICT (school_id, parent_user_id, student_id) DO NOTHING
    `;
    summary.parents_linked++;
  }
}
