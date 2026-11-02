// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createSchool,
  createTeacher,
  createUser,
  assignRole,
  createEvaluationCriteriaTemplate,
  createEvaluationScore,
  integrationEnabled,
  type TestDatabase,
  type UserRecord,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import {
  listTemplates,
  createTemplate,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  listEvaluations,
  getEvaluation,
  createEvaluation,
  updateEvaluation,
  submitEvaluation,
  shareEvaluationWithTeacher,
  getEvaluationScores,
  upsertScore,
  deleteScore,
} from "../evaluation-service";

import type { TransactionSql } from "postgres";

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

/**
 * Run `fn` as `userId` in the same tenant transaction a route opens (`withTenantTx`): role
 * studafy_app with `app.school_id` and `app.user_id` armed. The acting user is load-bearing here:
 * teacher_evaluation_visibility is a RESTRICTIVE SELECT policy that reads `app.user_id` (and raises
 * when it is unset), admitting only the evaluator and -- once shared -- the evaluated teacher.
 */
function withTx<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return withTenantTx(db.sql, { schoolId, userId }, fn);
}

/**
 * Seed a draft evaluation through the real service, acting as its evaluator -- the production path.
 *
 * Not the harness `createTeacherEvaluation` factory: its `INSERT ... RETURNING` runs as studafy_app
 * with no `app.user_id`, and teacher_evaluation_visibility (a RESTRICTIVE SELECT policy, which
 * PostgreSQL also applies to RETURNING) calls `app.current_user_id()`, which raises on the unset GUC.
 */
function seedEvaluation(
  schoolId: string,
  teacherId: string,
  evaluatorUserId: string,
): Promise<{ id: string }> {
  return withTx(schoolId, evaluatorUserId, (tx) =>
    createEvaluation(tx, schoolId, evaluatorUserId, {
      teacher_id: teacherId,
      evaluation_type: "formal_observation",
      evaluated_at: new Date().toISOString(),
    }),
  );
}

/** A PRINCIPAL of the school: the role that manages criteria templates and evaluates teachers. */
async function createPrincipal(schoolId: string): Promise<UserRecord> {
  const principal = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, principal.id, "PRINCIPAL");
  return principal;
}

describeDb("createTemplate", () => {
  test("creates and returns a new criteria template", async () => {
    const school = await createSchool(db.sql);
    const principal = await createPrincipal(school.id);

    const template = await withTx(school.id, principal.id, (tx) =>
      createTemplate(tx, school.id, {
        title: "Classroom Management",
        description: "Assesses classroom management skills",
        max_score: 10,
        sort_order: 0,
      }),
    );

    expect(template).toBeDefined();
    expect(template.title).toBe("Classroom Management");
    expect(template.max_score).toBe(10);
    expect(template.is_active).toBe(true);
  });
});

describeDb("listTemplates", () => {
  test("returns paginated templates", async () => {
    const school = await createSchool(db.sql);
    const principal = await createPrincipal(school.id);

    await createEvaluationCriteriaTemplate(db.sql, school.id, { title: "A" });
    await createEvaluationCriteriaTemplate(db.sql, school.id, { title: "B" });

    const { rows, total } = await withTx(school.id, principal.id, (tx) =>
      listTemplates(tx, school.id, { limit: 10, offset: 0 }),
    );

    expect(total).toBe(2);
    expect(rows).toHaveLength(2);
  });
});

describeDb("getTemplate", () => {
  test("returns template by id", async () => {
    const school = await createSchool(db.sql);
    const principal = await createPrincipal(school.id);

    const created = await createEvaluationCriteriaTemplate(db.sql, school.id, {
      title: "Lesson Planning",
    });

    const template = await withTx(school.id, principal.id, (tx) =>
      getTemplate(tx, school.id, created.id),
    );

    expect(template).toBeDefined();
    expect(template!.id).toBe(created.id);
  });

  test("returns undefined for non-existent template", async () => {
    const school = await createSchool(db.sql);
    const principal = await createPrincipal(school.id);

    const template = await withTx(school.id, principal.id, (tx) =>
      getTemplate(tx, school.id, "00000000-0000-0000-0000-000000000000"),
    );

    expect(template).toBeUndefined();
  });
});

describeDb("updateTemplate", () => {
  test("updates title and max_score", async () => {
    const school = await createSchool(db.sql);
    const principal = await createPrincipal(school.id);

    const created = await createEvaluationCriteriaTemplate(db.sql, school.id, {
      title: "Original Title",
      maxScore: 5,
    });

    const updated = await withTx(school.id, principal.id, (tx) =>
      updateTemplate(tx, school.id, created.id, {
        title: "Updated Title",
        max_score: 10,
      }),
    );

    expect(updated.title).toBe("Updated Title");
    expect(updated.max_score).toBe(10);
  });
});

describeDb("deleteTemplate", () => {
  test("soft-deletes a template", async () => {
    const school = await createSchool(db.sql);
    const principal = await createPrincipal(school.id);

    const created = await createEvaluationCriteriaTemplate(db.sql, school.id);

    await withTx(school.id, principal.id, (tx) => deleteTemplate(tx, school.id, created.id));

    const template = await withTx(school.id, principal.id, (tx) =>
      getTemplate(tx, school.id, created.id),
    );

    expect(template).toBeDefined();
    expect(template!.is_active).toBe(false);
  });
});

describeDb("createEvaluation", () => {
  test("creates and returns a new evaluation in draft status", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const evaluation = await withTx(school.id, user.id, (tx) =>
      createEvaluation(tx, school.id, user.id, {
        teacher_id: teacher.id,
        evaluation_type: "formal_observation",
        evaluated_at: new Date().toISOString(),
      }),
    );

    expect(evaluation).toBeDefined();
    expect(evaluation.status).toBe("draft");
    expect(evaluation.teacher_id).toBe(teacher.id);
    expect(evaluation.evaluator_user_id).toBe(user.id);
    expect(evaluation.shared_with_teacher).toBe(false);
  });
});

describeDb("listEvaluations", () => {
  test("returns evaluations for principal", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    await seedEvaluation(school.id, teacher.id, user.id);

    const { rows, total } = await withTx(school.id, user.id, (tx) =>
      listEvaluations(tx, school.id, user.id, false, { limit: 10, offset: 0 }),
    );

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
  });

  test("teacher sees only shared evaluations", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const evaluator = await createPrincipal(school.id);
    await assignRole(db.sql, school.id, teacher.userId, "INSTRUCTOR");

    await seedEvaluation(school.id, teacher.id, evaluator.id);

    const { rows, total } = await withTx(school.id, teacher.userId, (tx) =>
      listEvaluations(tx, school.id, teacher.userId, true, { limit: 10, offset: 0 }),
    );

    expect(total).toBe(0);
    expect(rows).toHaveLength(0);
  });
});

describeDb("getEvaluation", () => {
  test("returns evaluation by id with scores", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const created = await seedEvaluation(school.id, teacher.id, user.id);

    const evaluation = await withTx(school.id, user.id, (tx) =>
      getEvaluation(tx, school.id, created.id),
    );

    expect(evaluation).toBeDefined();
    expect(evaluation!.id).toBe(created.id);
    expect(evaluation!.scores).toEqual([]);
  });
});

describeDb("updateEvaluation", () => {
  test("updates rating and narrative", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const created = await seedEvaluation(school.id, teacher.id, user.id);

    const updated = await withTx(school.id, user.id, (tx) =>
      updateEvaluation(tx, school.id, created.id, {
        rating: "proficient",
        narrative: "Strong teaching skills overall",
      }),
    );

    expect(updated.rating).toBe("proficient");
    expect(updated.narrative).toBe("Strong teaching skills overall");
  });
});

describeDb("submitEvaluation", () => {
  test("transitions draft to submitted", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const created = await seedEvaluation(school.id, teacher.id, user.id);

    const submitted = await withTx(school.id, user.id, (tx) =>
      submitEvaluation(tx, school.id, created.id),
    );

    expect(submitted.status).toBe("submitted");
  });

  test("rejects submit on already submitted evaluation", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const created = await seedEvaluation(school.id, teacher.id, user.id);

    await withTx(school.id, user.id, (tx) => submitEvaluation(tx, school.id, created.id));

    await expect(
      withTx(school.id, user.id, (tx) => submitEvaluation(tx, school.id, created.id)),
    ).rejects.toThrow("Cannot submit");
  });
});

describeDb("shareEvaluationWithTeacher", () => {
  test("sets shared_with_teacher and shared_at", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const created = await seedEvaluation(school.id, teacher.id, user.id);

    const shared = await withTx(school.id, user.id, (tx) =>
      shareEvaluationWithTeacher(tx, school.id, created.id),
    );

    expect(shared.shared_with_teacher).toBe(true);
    expect(shared.shared_at).not.toBeNull();
  });

  test("rejects share on already shared evaluation", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const created = await seedEvaluation(school.id, teacher.id, user.id);

    await withTx(school.id, user.id, (tx) => shareEvaluationWithTeacher(tx, school.id, created.id));

    await expect(
      withTx(school.id, user.id, (tx) => shareEvaluationWithTeacher(tx, school.id, created.id)),
    ).rejects.toThrow("already shared");
  });
});

describeDb("upsertScore", () => {
  test("creates and updates a score", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const template = await withTx(school.id, user.id, (tx) =>
      createTemplate(tx, school.id, {
        title: "Test",
        max_score: 10,
        sort_order: 0,
      }),
    );

    const evaluation = await seedEvaluation(school.id, teacher.id, user.id);

    const score = await withTx(school.id, user.id, (tx) =>
      upsertScore(tx, school.id, evaluation.id, template.id, {
        score: 8,
        comment: "Good classroom control",
      }),
    );

    expect(score).toBeDefined();
    expect(score.score).toBe(8);
    expect(score.comment).toBe("Good classroom control");
    expect(score.criteria_template_id).toBe(template.id);

    const updated = await withTx(school.id, user.id, (tx) =>
      upsertScore(tx, school.id, evaluation.id, template.id, {
        score: 9,
      }),
    );

    expect(updated.score).toBe(9);
  });

  test("rejects score exceeding template max", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const template = await withTx(school.id, user.id, (tx) =>
      createTemplate(tx, school.id, {
        title: "Test",
        max_score: 5,
        sort_order: 0,
      }),
    );

    const evaluation = await seedEvaluation(school.id, teacher.id, user.id);

    await expect(
      withTx(school.id, user.id, (tx) =>
        upsertScore(tx, school.id, evaluation.id, template.id, {
          score: 10,
        }),
      ),
    ).rejects.toThrow("exceeds template max score");
  });
});

describeDb("deleteScore", () => {
  test("deletes a score", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const template = await withTx(school.id, user.id, (tx) =>
      createTemplate(tx, school.id, {
        title: "Test",
        max_score: 10,
        sort_order: 0,
      }),
    );

    const evaluation = await seedEvaluation(school.id, teacher.id, user.id);

    await createEvaluationScore(db.sql, school.id, {
      evaluationId: evaluation.id,
      criteriaTemplateId: template.id,
    });

    await withTx(school.id, user.id, (tx) =>
      deleteScore(tx, school.id, evaluation.id, template.id),
    );

    const scores = await withTx(school.id, user.id, (tx) =>
      getEvaluationScores(tx, school.id, evaluation.id),
    );

    expect(scores).toHaveLength(0);
  });
});

describeDb("getEvaluationScores", () => {
  test("returns scores for an evaluation", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const user = await createPrincipal(school.id);

    const template = await withTx(school.id, user.id, (tx) =>
      createTemplate(tx, school.id, {
        title: "Test",
        max_score: 10,
        sort_order: 0,
      }),
    );

    const evaluation = await seedEvaluation(school.id, teacher.id, user.id);

    await createEvaluationScore(db.sql, school.id, {
      evaluationId: evaluation.id,
      criteriaTemplateId: template.id,
    });

    const scores = await withTx(school.id, user.id, (tx) =>
      getEvaluationScores(tx, school.id, evaluation.id),
    );

    expect(scores).toHaveLength(1);
    expect(scores[0]?.criteria_template_id).toBe(template.id);
  });
});
