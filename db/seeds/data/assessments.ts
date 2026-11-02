// Assessment and grading workflow for the Science class: a published assignment with graded
// submissions, a closed exam with published results, and a gradebook whose per-student submissions are
// carried draft -> submitted -> approved -> published (the 000013 state machine owns the audit
// timestamps, so each step is an UPDATE, not an inserted value). The Math class gets a published
// gradebook for its whole roster too, so Math-only students have grades. Grades are decoupled from
// assignments/exams by design, so they hang off grade_submissions only.
import { seedDate, uuid } from "../support";

import type { FullCtx, Sql } from "../support";

export async function seedAssessments(sql: Sql, ctx: FullCtx): Promise<void> {
  const { schoolId, classes, students, teachers, orgAdmin } = ctx;
  const scienceClass = classes[0]!;
  const teacher = teachers.find((t) => t.key === "instructor-science")!;
  // Enrolled Science students are the first five (see academics.ts); grade the first three.
  const gradedStudents = students.slice(0, 3);

  // --- Assignment + submissions ---
  const assignmentId = uuid();
  await sql`
    INSERT INTO app.assignments ${sql({
      id: assignmentId,
      school_id: schoolId,
      class_id: scienceClass.id,
      created_by_user_id: teacher.userId,
      last_edited_by_user_id: teacher.userId,
      title: "Photosynthesis Lab Report",
      description: "Write up the results of the classroom photosynthesis experiment.",
      instructions: "Include a hypothesis, method, results table, and a short conclusion.",
      status: "published",
      available_from: seedDate(-6),
      assigned_at: seedDate(-5),
      due_at: seedDate(6),
      max_score: 100,
      allow_late_submission: true,
    })}
  `;

  await sql`
    INSERT INTO app.assignment_submissions ${sql(
      gradedStudents.map((student, index) => ({
        id: uuid(),
        school_id: schoolId,
        assignment_id: assignmentId,
        student_id: student.studentId,
        last_edited_by_user_id: student.userId,
        graded_by_user_id: teacher.userId,
        status: "graded",
        // ck_assignment_submissions_lifecycle (000049) requires status='graded' to imply
        // grade_status='published'. The two record one fact -- the mark is released -- and the
        // constraint is what stops them disagreeing, so every writer must set both.
        grade_status: "published",
        submitted_at: seedDate(-2, 12),
        graded_at: seedDate(-1, 12),
        score: 78 + index * 6,
        feedback: "Solid analysis; tighten the conclusion next time.",
      })),
      "id",
      "school_id",
      "assignment_id",
      "student_id",
      "last_edited_by_user_id",
      "graded_by_user_id",
      "status",
      "grade_status",
      "submitted_at",
      "graded_at",
      "score",
      "feedback",
    )}
  `;

  // --- Exam + results ---
  const examId = uuid();
  await sql`
    INSERT INTO app.exams ${sql({
      id: examId,
      school_id: schoolId,
      class_id: scienceClass.id,
      created_by_user_id: teacher.userId,
      last_edited_by_user_id: teacher.userId,
      title: "Unit 1 Science Exam",
      description: "Covers cells, energy, and photosynthesis.",
      status: "closed",
      starts_at: seedDate(-3, 9),
      ends_at: seedDate(-3, 11),
      max_score: 100,
    })}
  `;

  await sql`
    INSERT INTO app.exam_results ${sql(
      gradedStudents.map((student, index) => ({
        id: uuid(),
        school_id: schoolId,
        exam_id: examId,
        student_id: student.studentId,
        last_edited_by_user_id: teacher.userId,
        graded_by_user_id: teacher.userId,
        published_by_user_id: teacher.userId,
        status: "published",
        score: 82 + index * 4,
        feedback: "Well done.",
        graded_at: seedDate(-2, 15),
        published_at: seedDate(-1, 15),
      })),
      "id",
      "school_id",
      "exam_id",
      "student_id",
      "last_edited_by_user_id",
      "graded_by_user_id",
      "published_by_user_id",
      "status",
      "score",
      "feedback",
      "graded_at",
      "published_at",
    )}
  `;

  // --- Gradebooks + published submissions + grades ---
  await seedPublishedGradebook(sql, {
    schoolId,
    classId: scienceClass.id,
    teacherUserId: teacher.userId,
    approverUserId: orgAdmin.userId,
    studentIds: gradedStudents.map((student) => student.studentId),
  });

  // The Math class has no assignment/exam, but its whole roster has published gradebook marks, so
  // every Math-only student (e.g. Mira Fares) has grades to show.
  const mathClass = classes[1]!;
  const mathTeacher = teachers.find((t) => t.key === "instructor-math")!;
  await seedPublishedGradebook(sql, {
    schoolId,
    classId: mathClass.id,
    teacherUserId: mathTeacher.userId,
    approverUserId: orgAdmin.userId,
    studentIds: ctx.enrollments
      .filter((enrollment) => enrollment.classId === mathClass.id)
      .map((enrollment) => enrollment.studentId),
  });
}

// One active gradebook for a class with a published grade_submission (Midterm + Homework marks) per
// student, each walked draft -> submitted -> approved -> published.
async function seedPublishedGradebook(
  sql: Sql,
  input: {
    schoolId: string;
    classId: string;
    teacherUserId: string;
    approverUserId: string;
    studentIds: readonly string[];
  },
): Promise<void> {
  const { schoolId, classId, studentIds } = input;
  const gradebookId = uuid();
  await sql`
    INSERT INTO app.gradebooks ${sql({
      id: gradebookId,
      school_id: schoolId,
      class_id: classId,
      status: "active",
    })}
  `;

  const submissionIds = studentIds.map(() => uuid());
  await sql`
    INSERT INTO app.grade_submissions ${sql(
      studentIds.map((studentId, index) => ({
        id: submissionIds[index]!,
        school_id: schoolId,
        gradebook_id: gradebookId,
        student_id: studentId,
        status: "draft",
      })),
      "id",
      "school_id",
      "gradebook_id",
      "student_id",
      "status",
    )}
  `;

  const gradeRows = submissionIds.flatMap((submissionId, index) => [
    {
      id: uuid(),
      school_id: schoolId,
      grade_submission_id: submissionId,
      score: 80 + (index % 5) * 5,
      max_score: 100,
      weight: 1,
      label: "Midterm",
    },
    {
      id: uuid(),
      school_id: schoolId,
      grade_submission_id: submissionId,
      score: 17 + (index % 4),
      max_score: 20,
      weight: 0.5,
      label: "Homework",
    },
  ]);
  await sql`
    INSERT INTO app.grades ${sql(
      gradeRows,
      "id",
      "school_id",
      "grade_submission_id",
      "score",
      "max_score",
      "weight",
      "label",
    )}
  `;

  // Walk each submission through the approval state machine to 'published'.
  for (const submissionId of submissionIds) {
    await sql`
      UPDATE app.grade_submissions
      SET status = 'submitted', submitted_by_user_id = ${input.teacherUserId}
      WHERE id = ${submissionId} AND school_id = ${schoolId}
    `;
    await sql`
      UPDATE app.grade_submissions
      SET status = 'approved', decided_by_user_id = ${input.approverUserId}
      WHERE id = ${submissionId} AND school_id = ${schoolId}
    `;
    await sql`
      UPDATE app.grade_submissions
      SET status = 'published'
      WHERE id = ${submissionId} AND school_id = ${schoolId}
    `;
  }
}
