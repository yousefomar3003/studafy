/**
 * Question assignments (db/migrations/000167): teacher-authored multiple-choice and true/false
 * questions, answered by students and marked automatically.
 *
 * The two privacy rules -- the answer key is withheld from students, and whether a student's own
 * answers were right is withheld until the mark is released -- are projection rules, so they are
 * proved first without a database and can never silently skip. The rest are integration tests in
 * the style of assignments.test.ts and need a live PostgreSQL instance:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academics/assignments/__tests__
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createAcademicYear,
  createClass,
  createCourse,
  createEnrollment,
  createRoom,
  createSchool,
  createStudent,
  createSubject,
  createTeacher,
  createTerm,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../../tests/harness";
import { buildTempKey } from "../../../../lib/storage";
import { autoScore, listAnswersBySubmission } from "../../submissions/answer-service";
import { toSubmissionResponse } from "../../submissions/routes/submission-routes";
import { gradeSubmission, submitAssignment } from "../../submissions/submission-service";
import { createAssignment, updateAssignment } from "../assignment-service";
import { listQuestionsByAssignment, replaceQuestions } from "../question-service";
import { toQuestionResponse } from "../routes/assignment-routes";
import { replaceQuestionsBodySchema } from "../schemas";

import type { PresignedUrl, StorageService } from "../../../../lib/storage";
import type { AnswerRow } from "../../submissions/answer-service";
import type { SubmissionRow } from "../../submissions/submission-service";
import type { QuestionRow } from "../question-service";
import type { QuestionInput } from "../schemas";
import type { Sql, TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Projection rules (no database)
// ---------------------------------------------------------------------------

function questionRow(viewerIsStaff: boolean): QuestionRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    assignment_id: "00000000-0000-4000-8000-000000000002",
    position: 1,
    question_type: "multiple_choice",
    points: "2.00",
    prompt: "Where does photosynthesis happen?",
    image_storage_key: null,
    image_mime_type: null,
    image_size_bytes: null,
    viewer_is_staff: viewerIsStaff,
    options: [
      {
        id: "00000000-0000-4000-8000-000000000011",
        position: 1,
        text: "Nucleus",
        is_correct: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        position: 2,
        text: "Chloroplast",
        is_correct: true,
      },
    ],
  };
}

function submissionRow(gradeStatus: SubmissionRow["grade_status"]): SubmissionRow {
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-000000000020",
    school_id: "00000000-0000-4000-8000-000000000021",
    assignment_id: "00000000-0000-4000-8000-000000000002",
    student_id: "00000000-0000-4000-8000-000000000022",
    content: null,
    status: gradeStatus === "published" ? "graded" : "submitted",
    grade_status: gradeStatus,
    is_late: false,
    attempt_number: 1,
    submitted_at: now,
    graded_at: gradeStatus === "none" ? null : now,
    graded_by_user_id: gradeStatus === "none" ? null : "00000000-0000-4000-8000-000000000023",
    score: gradeStatus === "none" ? null : "2.00",
    feedback: null,
    last_edited_by_user_id: "00000000-0000-4000-8000-000000000022",
    created_at: now,
    updated_at: now,
  };
}

const answers: AnswerRow[] = [
  {
    submission_id: "00000000-0000-4000-8000-000000000020",
    question_id: "00000000-0000-4000-8000-000000000001",
    option_id: "00000000-0000-4000-8000-000000000012",
    is_correct: true,
    correct_option_id: "00000000-0000-4000-8000-000000000012",
    points: "2.00",
  },
  {
    submission_id: "00000000-0000-4000-8000-000000000020",
    question_id: "00000000-0000-4000-8000-000000000003",
    option_id: "00000000-0000-4000-8000-000000000031",
    is_correct: false,
    correct_option_id: "00000000-0000-4000-8000-000000000032",
    points: "1.50",
  },
];

describe("question set bounds", () => {
  const question = (overrides: Partial<QuestionInput> = {}): QuestionInput => ({
    question_type: "multiple_choice",
    prompt: "Pick one",
    points: 1,
    options: [
      { text: "A", is_correct: true },
      { text: "B", is_correct: false },
    ],
    ...overrides,
  });
  const parse = (questions: QuestionInput[]) => replaceQuestionsBodySchema.safeParse({ questions });

  test("takes up to twenty questions", () => {
    expect(parse(Array.from({ length: 20 }, () => question())).success).toBe(true);
    expect(parse(Array.from({ length: 21 }, () => question())).success).toBe(false);
  });

  test("takes two to four options", () => {
    const options = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        text: `Option ${index + 1}`,
        is_correct: index === 0,
      }));
    expect(parse([question({ options: options(1) })]).success).toBe(false);
    expect(parse([question({ options: options(4) })]).success).toBe(true);
    expect(parse([question({ options: options(5) })]).success).toBe(false);
  });

  test("a question needs text or a picture", () => {
    expect(parse([question({ prompt: "   " })]).success).toBe(false);
    expect(
      parse([question({ prompt: "", image: { upload_key: "temp/school/object/cell.png" } })])
        .success,
    ).toBe(true);
  });

  test("one picture cannot be used by two questions", () => {
    const image = { upload_key: "temp/school/object/cell.png" };
    expect(parse([question({ image }), question({ image })]).success).toBe(false);
  });
});

describe("answer key projection", () => {
  test("a student never sees which option is correct", () => {
    const projected = toQuestionResponse(questionRow(false));
    expect(projected.options.map((option) => option.is_correct)).toEqual([null, null]);
    expect(projected.points).toBe(2);
  });

  test("the class's teacher sees the key", () => {
    const projected = toQuestionResponse(questionRow(true));
    expect(projected.options.map((option) => option.is_correct)).toEqual([false, true]);
  });
});

describe("answer marking projection", () => {
  test("a student sees their own choices but not whether they were right before release", () => {
    for (const status of ["none", "draft"] as const) {
      const projected = toSubmissionResponse(submissionRow(status), [], false, answers);
      expect(projected.answers.map((answer) => answer.option_id)).toEqual([
        "00000000-0000-4000-8000-000000000012",
        "00000000-0000-4000-8000-000000000031",
      ]);
      expect(projected.answers.every((answer) => answer.is_correct === null)).toBe(true);
      expect(projected.answers.every((answer) => answer.correct_option_id === null)).toBe(true);
      expect(projected.auto_score).toBeNull();
    }
  });

  test("released marks show correctness, the correct option, and the auto score", () => {
    const projected = toSubmissionResponse(submissionRow("published"), [], false, answers);
    expect(projected.answers.map((answer) => answer.is_correct)).toEqual([true, false]);
    expect(projected.answers[1]?.correct_option_id).toBe("00000000-0000-4000-8000-000000000032");
    expect(projected.auto_score).toBe(2);
  });

  test("staff see the auto score while marking", () => {
    expect(toSubmissionResponse(submissionRow("none"), [], true, answers).auto_score).toBe(2);
  });

  test("a written assignment carries no answers and no auto score", () => {
    const projected = toSubmissionResponse(submissionRow("published"), [], true);
    expect(projected.answers).toEqual([]);
    expect(projected.auto_score).toBeNull();
  });

  test("auto score sums only the correct answers' points", () => {
    expect(autoScore(answers)).toBe(2);
    expect(autoScore([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

/** Run as a specific user under studafy_app, so the restrictive policies actually apply. */
async function asUser<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    result = await fn(tx);
  });
  return result as T;
}

/** One school, two teachers with a class each, and two students in the first class. */
async function seedTenant(sql: Sql) {
  const school = await createSchool(sql);
  const teacherA = await createTeacher(sql, school.id);
  const teacherB = await createTeacher(sql, school.id);
  const year = await createAcademicYear(sql, school.id);
  const term = await createTerm(sql, school.id, year.id);
  const subject = await createSubject(sql, school.id);
  const course = await createCourse(sql, school.id, subject.id);
  const room = await createRoom(sql, school.id);

  const classA = await createClass(sql, school.id, {
    courseId: course.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacherA.id,
    roomId: room.id,
  });
  const classB = await createClass(sql, school.id, {
    courseId: course.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacherB.id,
    roomId: room.id,
  });

  const studentA = await createStudent(sql, school.id);
  const studentB = await createStudent(sql, school.id);
  await createEnrollment(sql, school.id, classA.id, studentA.id);
  await createEnrollment(sql, school.id, classA.id, studentB.id);

  return { school, teacherA, teacherB, classA, classB, studentA, studentB };
}

function futureIso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

const QUESTIONS: QuestionInput[] = [
  {
    question_type: "multiple_choice",
    prompt: "Which organelle carries out photosynthesis?",
    points: 2,
    options: [
      { text: "Mitochondrion", is_correct: false },
      { text: "Chloroplast", is_correct: true },
      { text: "Nucleus", is_correct: false },
    ],
  },
  {
    question_type: "true_false",
    prompt: "Animal cells have a cell wall.",
    points: 1.5,
    options: [
      { text: "True", is_correct: false },
      { text: "False", is_correct: true },
    ],
  },
];

/** A published questions assignment on class A with QUESTIONS saved. */
async function seedQuestionAssignment(t: Awaited<ReturnType<typeof seedTenant>>) {
  return asUser(t.school.id, t.teacherA.userId, async (tx) => {
    const draft = await createAssignment(tx, t.school.id, t.teacherA.userId, {
      class_id: t.classA.id,
      title: "Cells quiz",
      due_at: futureIso(7),
      max_score: 1,
      allow_late_submission: false,
      status: "draft",
      kind: "questions",
    });
    await replaceQuestions(tx, t.school.id, t.teacherA.userId, draft.id, QUESTIONS);
    await updateAssignment(tx, t.school.id, t.teacherA.userId, draft.id, { status: "published" });
    const questions = (await listQuestionsByAssignment(tx, t.school.id, [draft.id])).get(draft.id)!;
    return { assignmentId: draft.id, questions };
  });
}

/** The answers that pick option `picks[i]` (0-based) for question i. */
function answersFor(questions: QuestionRow[], picks: number[]) {
  return questions.map((question, index) => ({
    question_id: question.id,
    option_id: question.options.at(picks.at(index) ?? 0)!.id,
  }));
}

describeDb("authoring", () => {
  test("a questions assignment cannot be created straight into published", async () => {
    const t = await seedTenant(db.sql);
    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        createAssignment(tx, t.school.id, t.teacherA.userId, {
          class_id: t.classA.id,
          title: "Quiz",
          due_at: futureIso(7),
          max_score: 1,
          allow_late_submission: false,
          status: "published",
          kind: "questions",
        }),
      ),
    ).rejects.toThrow(/at least one question/i);
  });

  test("a draft without questions cannot be published", async () => {
    const t = await seedTenant(db.sql);
    await expect(
      asUser(t.school.id, t.teacherA.userId, async (tx) => {
        const draft = await createAssignment(tx, t.school.id, t.teacherA.userId, {
          class_id: t.classA.id,
          title: "Quiz",
          due_at: futureIso(7),
          max_score: 1,
          allow_late_submission: false,
          status: "draft",
          kind: "questions",
        });
        return updateAssignment(tx, t.school.id, t.teacherA.userId, draft.id, {
          status: "published",
        });
      }),
    ).rejects.toThrow(/at least one question/i);
  });

  test("saving questions sets max_score to their total and stores them in order", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId, questions } = await seedQuestionAssignment(t);

    const [stored] = await db.sql<{ max_score: string; kind: string }[]>`
      SELECT max_score, kind FROM app.assignments WHERE id = ${assignmentId}
    `;
    expect(stored).toEqual({ max_score: "3.50", kind: "questions" });
    expect(questions.map((question) => question.prompt)).toEqual(QUESTIONS.map((q) => q.prompt));
    expect(questions[0]!.options.map((option) => option.text)).toEqual([
      "Mitochondrion",
      "Chloroplast",
      "Nucleus",
    ]);
  });

  test("a written assignment has no questions to edit", async () => {
    const t = await seedTenant(db.sql);
    await expect(
      asUser(t.school.id, t.teacherA.userId, async (tx) => {
        const written = await createAssignment(tx, t.school.id, t.teacherA.userId, {
          class_id: t.classA.id,
          title: "Essay",
          due_at: futureIso(7),
          max_score: 10,
          allow_late_submission: false,
          status: "draft",
        });
        return replaceQuestions(tx, t.school.id, t.teacherA.userId, written.id, QUESTIONS);
      }),
    ).rejects.toThrow(/only a questions assignment/i);
  });

  test("another teacher cannot edit the questions", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId } = await seedQuestionAssignment(t);
    await expect(
      asUser(t.school.id, t.teacherB.userId, (tx) =>
        replaceQuestions(tx, t.school.id, t.teacherB.userId, assignmentId, QUESTIONS),
      ),
    ).rejects.toThrow();
  });

  test("the key is visible to the teacher and not to a student", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId } = await seedQuestionAssignment(t);

    const asTeacher = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listQuestionsByAssignment(tx, t.school.id, [assignmentId]),
    );
    const asStudent = await asUser(t.school.id, t.studentA.userId, (tx) =>
      listQuestionsByAssignment(tx, t.school.id, [assignmentId]),
    );

    expect(asTeacher.get(assignmentId)!.every((question) => question.viewer_is_staff)).toBe(true);
    expect(asStudent.get(assignmentId)!.every((question) => !question.viewer_is_staff)).toBe(true);
  });
});

describeDb("answering", () => {
  test("every question must be answered", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId, questions } = await seedQuestionAssignment(t);
    await expect(
      asUser(t.school.id, t.studentA.userId, (tx) =>
        submitAssignment(tx, t.school.id, t.studentA.userId, t.studentA.id, assignmentId, {
          answers: answersFor(questions, [1]).slice(0, 1),
        }),
      ),
    ).rejects.toThrow(/answer every question/i);
  });

  test("an option from a different question is refused", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId, questions } = await seedQuestionAssignment(t);
    await expect(
      asUser(t.school.id, t.studentA.userId, (tx) =>
        submitAssignment(tx, t.school.id, t.studentA.userId, t.studentA.id, assignmentId, {
          answers: [
            { question_id: questions[0]!.id, option_id: questions[1]!.options[0]!.id },
            { question_id: questions[1]!.id, option_id: questions[1]!.options[1]!.id },
          ],
        }),
      ),
    ).rejects.toThrow(/does not belong to its question/i);
  });

  test("a hand-in is marked and its grade released at once", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId, questions } = await seedQuestionAssignment(t);

    // Wrong on question 1 (2 points), right on question 2 (1.5 points).
    const first = await asUser(t.school.id, t.studentA.userId, (tx) =>
      submitAssignment(tx, t.school.id, t.studentA.userId, t.studentA.id, assignmentId, {
        answers: answersFor(questions, [0, 1]),
      }),
    );
    expect(first.row.status).toBe("graded");
    expect(first.row.grade_status).toBe("published");
    expect(Number(first.row.score)).toBe(1.5);
    expect(first.row.graded_by_user_id).toBeNull();

    // The student sees the mark and the key straight away, with no teacher step.
    const seen = await asUser(t.school.id, t.studentA.userId, (tx) =>
      listAnswersBySubmission(tx, t.school.id, [first.row.id]),
    );
    const projected = toSubmissionResponse(first.row, [], false, seen.get(first.row.id)!);
    expect(projected.score).toBe(1.5);
    expect(projected.answers.map((answer) => answer.is_correct)).toEqual([false, true]);
  });

  test("a released quiz cannot be retaken until the teacher returns it", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId, questions } = await seedQuestionAssignment(t);
    const first = await asUser(t.school.id, t.studentA.userId, (tx) =>
      submitAssignment(tx, t.school.id, t.studentA.userId, t.studentA.id, assignmentId, {
        answers: answersFor(questions, [0, 1]),
      }),
    );

    await expect(
      asUser(t.school.id, t.studentA.userId, (tx) =>
        submitAssignment(tx, t.school.id, t.studentA.userId, t.studentA.id, assignmentId, {
          answers: answersFor(questions, [1, 1]),
        }),
      ),
    ).rejects.toThrow(/already been graded/i);

    await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, first.row.id, {
        publish: false,
        return_to_student: true,
      }),
    );

    // Both right, on the retake.
    const retake = await asUser(t.school.id, t.studentA.userId, (tx) =>
      submitAssignment(tx, t.school.id, t.studentA.userId, t.studentA.id, assignmentId, {
        answers: answersFor(questions, [1, 1]),
      }),
    );
    expect(Number(retake.row.score)).toBe(3.5);
    const remarked = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      listAnswersBySubmission(tx, t.school.id, [first.row.id]),
    );
    expect(remarked.get(first.row.id)).toHaveLength(2);
    expect(autoScore(remarked.get(first.row.id)!)).toBe(3.5);
  });

  test("questions are locked once a student has handed in", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId, questions } = await seedQuestionAssignment(t);
    await asUser(t.school.id, t.studentA.userId, (tx) =>
      submitAssignment(tx, t.school.id, t.studentA.userId, t.studentA.id, assignmentId, {
        answers: answersFor(questions, [1, 1]),
      }),
    );

    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        replaceQuestions(tx, t.school.id, t.teacherA.userId, assignmentId, QUESTIONS),
      ),
    ).rejects.toThrow(/cannot be changed/i);
  });

  test("a classmate cannot read another student's answers", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId, questions } = await seedQuestionAssignment(t);
    const { row } = await asUser(t.school.id, t.studentA.userId, (tx) =>
      submitAssignment(tx, t.school.id, t.studentA.userId, t.studentA.id, assignmentId, {
        answers: answersFor(questions, [1, 1]),
      }),
    );

    const seenByClassmate = await asUser(t.school.id, t.studentB.userId, (tx) =>
      listAnswersBySubmission(tx, t.school.id, [row.id]),
    );
    expect(seenByClassmate.size).toBe(0);
  });

  test("the teacher can re-mark an automatically released grade", async () => {
    const t = await seedTenant(db.sql);
    const { assignmentId, questions } = await seedQuestionAssignment(t);
    const { row } = await asUser(t.school.id, t.studentA.userId, (tx) =>
      submitAssignment(tx, t.school.id, t.studentA.userId, t.studentA.id, assignmentId, {
        answers: answersFor(questions, [1, 0]),
      }),
    );

    const graded = await asUser(t.school.id, t.teacherA.userId, (tx) =>
      gradeSubmission(tx, t.school.id, t.teacherA.userId, row.id, {
        score: 2,
        publish: true,
        return_to_student: false,
      }),
    );
    expect(graded.grade_status).toBe("published");
    expect(graded.graded_by_user_id).toBe(t.teacherA.userId);

    const answersSeen = await asUser(t.school.id, t.studentA.userId, (tx) =>
      listAnswersBySubmission(tx, t.school.id, [row.id]),
    );
    const projected = toSubmissionResponse(graded, [], false, answersSeen.get(row.id)!);
    expect(projected.auto_score).toBe(2);
    expect(projected.answers.map((answer) => answer.is_correct)).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// Pictures (000169)
// ---------------------------------------------------------------------------

/** In-memory storage holding staged PNGs, mirroring the fake in submission-attachments.test.ts. */
function fakeImageStorage(): StorageService & { objects: Map<string, number> } {
  const objects = new Map<string, number>();
  const base: StorageService = {
    ttlSeconds: 900,
    check: async () => true,
    presign(key): PresignedUrl {
      return {
        url: `https://storage.example/${key}?signed`,
        expiresAt: new Date(Date.now() + 900_000),
      };
    },
    async exists(key) {
      return objects.has(key);
    },
    async size(key) {
      return objects.get(key) ?? 0;
    },
    async head(key) {
      return objects.has(key)
        ? { contentType: "image/png", sizeBytes: objects.get(key) ?? 0 }
        : null;
    },
    async checksumSha256() {
      return "abcdef";
    },
    async copy(source, destination) {
      objects.set(destination, objects.get(source) ?? 0);
    },
    async remove(key) {
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, sizeBytes] of objects) {
        if (key.startsWith(prefix)) yield { key, sizeBytes };
      }
    },
  };
  return Object.assign(base, { objects });
}

describeDb("pictures", () => {
  async function draftQuiz(t: Awaited<ReturnType<typeof seedTenant>>) {
    return asUser(t.school.id, t.teacherA.userId, (tx) =>
      createAssignment(tx, t.school.id, t.teacherA.userId, {
        class_id: t.classA.id,
        title: "Organs quiz",
        due_at: futureIso(7),
        max_score: 1,
        allow_late_submission: false,
        status: "draft",
        kind: "questions",
      }),
    );
  }

  test("a staged picture is promoted, kept across a save, and can be removed", async () => {
    const t = await seedTenant(db.sql);
    const draft = await draftQuiz(t);
    const storage = fakeImageStorage();
    const tempKey = buildTempKey(t.school.id, crypto.randomUUID(), "heart.png");
    storage.objects.set(tempKey, 2048);

    const pictureOnly: QuestionInput = {
      ...QUESTIONS[0]!,
      prompt: "",
      image: { upload_key: tempKey },
    };
    const saved = await asUser(t.school.id, t.teacherA.userId, async (tx) => {
      await replaceQuestions(tx, t.school.id, t.teacherA.userId, draft.id, [pictureOnly], storage);
      return (await listQuestionsByAssignment(tx, t.school.id, [draft.id])).get(draft.id)!;
    });
    const stored = saved[0]!;
    expect(stored.prompt).toBe("");
    expect(stored.image_storage_key).toStartWith(`permanent/${t.school.id}/`);
    expect(stored.image_mime_type).toBe("image/png");
    expect(storage.objects.has(tempKey)).toBe(false);

    const kept = await asUser(t.school.id, t.teacherA.userId, async (tx) => {
      await replaceQuestions(
        tx,
        t.school.id,
        t.teacherA.userId,
        draft.id,
        [
          {
            ...pictureOnly,
            prompt: "Which organ is this?",
            image: { keep_from_question_id: stored.id },
          },
        ],
        storage,
      );
      return (await listQuestionsByAssignment(tx, t.school.id, [draft.id])).get(draft.id)!;
    });
    expect(kept[0]!.image_storage_key).toBe(stored.image_storage_key);

    const removed = await asUser(t.school.id, t.teacherA.userId, async (tx) => {
      await replaceQuestions(
        tx,
        t.school.id,
        t.teacherA.userId,
        draft.id,
        [{ ...QUESTIONS[0]!, image: null }],
        storage,
      );
      return (await listQuestionsByAssignment(tx, t.school.id, [draft.id])).get(draft.id)!;
    });
    expect(removed[0]!.image_storage_key).toBeNull();
  });

  test("a kept picture must come from this assignment", async () => {
    const t = await seedTenant(db.sql);
    const draft = await draftQuiz(t);
    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        replaceQuestions(
          tx,
          t.school.id,
          t.teacherA.userId,
          draft.id,
          [{ ...QUESTIONS[0]!, image: { keep_from_question_id: crypto.randomUUID() } }],
          fakeImageStorage(),
        ),
      ),
    ).rejects.toThrow(/keep_from_question_id/);
  });

  test("a staged picture from another school is refused", async () => {
    const t = await seedTenant(db.sql);
    const draft = await draftQuiz(t);
    const storage = fakeImageStorage();
    const foreignKey = buildTempKey(crypto.randomUUID(), crypto.randomUUID(), "heart.png");
    storage.objects.set(foreignKey, 2048);
    await expect(
      asUser(t.school.id, t.teacherA.userId, (tx) =>
        replaceQuestions(
          tx,
          t.school.id,
          t.teacherA.userId,
          draft.id,
          [{ ...QUESTIONS[0]!, image: { upload_key: foreignKey } }],
          storage,
        ),
      ),
    ).rejects.toThrow();
  });
});
