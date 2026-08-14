// Measures the ST-060 acceptance target: the build script parses every endpoint, runs its type
// assertions, emits the schema artifact, and completes in under 2 seconds.
//
// This is an ABSOLUTE wall-clock budget, and it is the only one in this directory. The two
// benchmarks beside it assert a delta for a documented reason -- an absolute budget on a shared CI
// runner measures the host as much as the code, and the NFR-05 probe had to be widened twice
// (500ms -> 600ms -> 1000ms) because it asserted a number within ~2x of its real cost. That reasoning
// still holds. It simply does not apply here: there is no "the same script without OpenAPI
// generation" arm to subtract, because generating the document is the entire program. The ticket
// promises a wall clock, so a wall clock is what this measures.
//
// What makes it defensible where NFR-05 was not:
//   - it reports a MEDIAN of several spawns, not one shot;
//   - the margin is several times the budget rather than ~2x;
//   - it measures the whole `bun run` -- process spawn and module import dominate, and those are
//     exactly where a regression would come from (someone adding a heavy import to the graph).
//
// Timing buildOpenApiDocument() in-process instead would report single-digit milliseconds against a
// 2000ms budget: true, meaningless, and blind to the regression that matters.
//
// If this flaps on CI, widen TARGET_MS or split spawn cost from generation cost. Do not lower
// MEASURED_ITERATIONS -- the median is what makes the number trustworthy.
//
// Gated in-file as well as in CI: `bun test` in this app globs every directory, and without the
// skipIf this would spawn subprocesses on every local unit-test invocation.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { expect, test } from "bun:test";

const benchmarkTest = test.skipIf(process.env.OPENAPI_BENCHMARK !== "1");

const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 5;
const TARGET_MS = 2_000;

/** Routes the document must contain, so a script that wrote nothing cannot pass by doing nothing. */
// Mirrors the list in src/openapi/document.test.ts. Two copies is one too many, and the duplication
// is why this file failed in CI while the whole local suite was green: it is gated on
// OPENAPI_BENCHMARK, so a new route updates the assertion nobody runs locally and misses this one.
// ST-071 and ST-073 both tripped over it independently, which is about as clear a signal as this
// kind of thing gives. Kept as its own list anyway rather than imported, because this benchmark
// deliberately asserts against a document produced by a *separate process spawn* — importing the
// expectation from the in-process suite would couple the two and weaken what this one proves.
const EXPECTED_PATHS = [
  "/.well-known/jwks.json",
  "/healthz",
  "/readyz",
  "/email/webhooks/sns",
  "/erpnext/webhooks",
  "/api/invitations",
  "/api/invitations/bulk",
  "/api/invitations/bulk/{bulkInviteId}",
  "/api/invitations/bulk/{bulkInviteId}/recipients",
  "/api/invitations/bulk/{bulkInviteId}/retry",
  "/api/invitations/{id}/regenerate",
  "/api/invitations/{id}/revoke",
  "/api/notifications",
  "/api/notifications/read-all",
  "/api/notifications/{notificationId}/read",
  "/api/notifications/unread-count",
  "/api/reports/children/comparison",
  "/api/reports/children/{studentId}/breakdown",
  "/api/notification-preferences",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/auth/invitations/{token}/activate",
  "/api/auth/invitations/{token}/verify",
  "/api/auth/login/oauth",
  "/api/auth/sessions",
  "/api/auth/sessions/{sessionId}",
  "/api/auth/devices",
  "/api/auth/devices/{deviceId}",
  "/api/auth/devices/{deviceId}/sessions",
  "/api/auth/providers",
  "/api/auth/providers/link/start",
  "/api/auth/providers/{provider}",
  "/api/admin/users/{userId}/devices",
  "/api/admin/users/{userId}/devices/{deviceId}",
  "/api/admin/users/{userId}/sessions",
  "/api/admin/users/{userId}/providers/{provider}",
  "/api/admin/subscriptions/sync-prices",
  "/api/approvals/bulk-decision",
  "/api/approvals/queue",
  "/api/attendance/records/batch",
  "/api/attendance/records/{recordId}",
  "/api/attendance/records/{recordId}/history",
  "/api/attendance/reports/export",
  "/api/attendance/reports/export/{jobId}",
  "/api/attendance/reports/summary",
  "/api/attendance/reports/trends",
  "/api/attendance/sessions",
  "/api/attendance/sessions/{sessionId}",
  "/api/audit/logs",
  "/api/audit/logs/export",
  "/api/audit/logs/export/{jobId}",
  "/api/finance/fee-structures",
  "/api/finance/fee-structures/{feeStructureId}",
  "/api/finance/fee-schedules/generate",
  "/api/finance/expenses",
  "/api/finance/expenses/{expenseId}",
  "/api/finance/expenses/upload-url",
  "/api/finance/expenses/{expenseId}/attachments",
  "/api/finance/expenses/summary",
  "/api/finance/scholarship-discounts",
  "/api/finance/scholarship-discounts/awards",
  "/api/finance/scholarship-discounts/awards/{awardId}/confirm",
  "/api/finance/payments",
  "/api/finance/payments/{paymentId}",
  "/api/finance/refunds",
  "/api/finance/refunds/{refundId}",
  "/api/finance/refunds/{refundId}/approve",
  "/api/finance/refunds/{refundId}/reject",
  "/api/finance/refunds/initiate",
  "/api/finance/webhooks/erpnext/payment-confirmed",
  "/api/finance/webhooks/erpnext/refund-processed",
  "/api/finance/reconciliation/run",
  "/api/finance/families/{familyId}",
  "/api/finance/students/{studentId}/installments",
  "/api/discipline/incidents",
  "/api/discipline/incidents/{incidentId}",
  "/api/discipline/incidents/{incidentId}/actions",
  "/api/discipline/incidents/{incidentId}/actions/{actionId}",
  "/api/discipline/incidents/{incidentId}/resolve",
  "/api/evaluations/templates",
  "/api/evaluations/templates/{templateId}",
  "/api/evaluations",
  "/api/evaluations/{evaluationId}",
  "/api/evaluations/{evaluationId}/submit",
  "/api/evaluations/{evaluationId}/share",
  "/api/evaluations/{evaluationId}/scores",
  "/api/evaluations/{evaluationId}/scores/{criteriaTemplateId}",
  "/api/families",
  "/api/families/{familyId}",
  "/api/families/{familyId}/links",
  "/api/families/{familyId}/links/{parentUserId}/{studentId}",
  "/api/finance/reports/ar-aging",
  "/api/finance/reports/collections-vs-due",
  "/api/finance/reports/export",
  "/api/finance/reports/export/{jobId}",
  "/api/finance/reports/family-statement/{familyId}",
  "/api/finance/reports/general-ledger",
  "/api/finance/reports/joinvoice/{invoiceId}",
  "/api/schools/register",
  "/api/schools/resend-verification",
  "/api/schools/verify-email/{token}",
  "/api/lookups/countries",
  "/api/lookups/currencies",
  "/api/schools/current/settings",
  "/api/schools/{schoolId}/provision",
  "/api/schools/{schoolId}/provisioning-status",
  "/api/storage/downloads/{contentClass}/{objectId}",
  "/api/storage/uploads/confirm",
  "/api/storage/uploads/request-upload",
  "/api/students",
  "/api/students/{studentId}",
  "/api/students/{studentId}/guardians",
  "/api/students/{studentId}/guardians/{userId}",
  "/api/subscriptions/ai/checkout",
  "/api/subscriptions/checkout",
  "/api/subscriptions/current",
  "/api/subscriptions/current/cancel",
  "/api/subscriptions/current/cancel/reverse",
  "/api/subscriptions/current/invoices",
  "/api/subscriptions/plans",
  "/api/subscriptions/portal",
  "/api/subscriptions/school/checkout",
  "/api/subscriptions/webhook/stripe",
  "/api/imports/students",
  "/api/imports/students/template",
  "/api/imports/students/upload",
  "/api/imports/students/{importId}",
  "/api/imports/students/{importId}/confirm",
  "/api/teachers",
  "/api/teachers/me",
  "/api/teachers/{teacherId}",
  "/api/academics/years",
  "/api/academics/years/{yearId}",
  "/api/academics/years/{yearId}/rollover",
  "/api/academics/years/{yearId}/terms",
  "/api/academics/terms/{termId}",
  "/api/academics/subjects",
  "/api/academics/subjects/{subjectId}",
  "/api/academics/subjects/{subjectId}/courses",
  "/api/academics/courses/{courseId}",
  "/api/academics/classes",
  "/api/academics/classes/{classId}",
  "/api/academics/assignments",
  "/api/academics/assignments/{assignmentId}",
  "/api/academics/assignments/{assignmentId}/attachments",
  "/api/academics/assignments/{assignmentId}/attachments/upload-url",
  "/api/academics/assignments/{assignmentId}/attachments/{attachmentId}",
  "/api/academics/assignments/{assignmentId}/submissions",
  "/api/academics/submissions/{submissionId}",
  "/api/academics/submissions/{submissionId}/grade",
  "/api/academics/submissions/{submissionId}/attachments",
  "/api/academics/submissions/{submissionId}/attachments/upload-url",
  "/api/academics/submissions/{submissionId}/attachments/{attachmentId}",
  "/api/academics/classes/{classId}/enrollments",
  "/api/academics/classes/{classId}/enrollments/transfer",
  "/api/academics/classes/{classId}/enrollments/{studentId}",
  "/api/academics/slots/{slotId}",
  "/api/academics/timetable-versions",
  "/api/academics/timetable-versions/{versionId}",
  "/api/academics/timetable-versions/{versionId}/approve",
  "/api/academics/timetable-versions/{versionId}/reject",
  "/api/academics/timetable-versions/{versionId}/slots",
  "/api/academics/timetable-versions/{versionId}/submit",
  "/api/academics/timetable-versions/copy",
  "/api/academics/exams",
  "/api/academics/exams/{examId}",
  "/api/academics/materials",
  "/api/academics/materials/{materialId}",
  "/api/academics/materials/{materialId}/ai-visible",
  "/api/academics/materials/{materialId}/confirm",
  "/api/academics/materials/upload",
  "/api/grades/config/gradebooks/{gradebookId}/categories",
  "/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}",
  "/api/grades/config/gradebooks/{gradebookId}/scheme",
  "/api/grades/config/gradebooks/{gradebookId}/scheme/link",
  "/api/grades/config/schemes",
  "/api/grades/config/schemes/{schemeId}",
  "/api/grades/gradebooks/{gradebookId}/entry",
  "/api/grades/gradebooks/{gradebookId}/grades",
  "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/decide",
  "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/submit",
  "/api/grades/gradebooks/{gradebookId}/submissions/{submissionId}/unlock",
  "/api/grades/published/students/{studentId}/terms/{termId}",
  "/api/users",
  "/api/users/status-counts",
  "/api/users/{userId}",
  "/api/users/{userId}/role",
  "/api/users/{userId}/deactivate",
];

const SCRIPT = path.join(import.meta.dir, "..", "..", "scripts", "generate-openapi.ts");
const CWD = path.join(import.meta.dir, "..", "..");

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function report(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  console.log(
    `${label}: min=${sorted[0]!.toFixed(1)}ms median=${median.toFixed(1)}ms ` +
      `p95=${percentile(sorted, 0.95).toFixed(1)}ms max=${sorted[sorted.length - 1]!.toFixed(1)}ms`,
  );
  return median;
}

/**
 * Run the real script exactly as `bun run openapi:generate` does, writing to a scratch path.
 *
 * OPENAPI_OUT keeps the benchmark from overwriting the regular output path.
 */
async function generate(outPath: string): Promise<number> {
  const startedAt = performance.now();
  const proc = Bun.spawn(["bun", "run", SCRIPT], {
    cwd: CWD,
    env: { ...process.env, OPENAPI_OUT: outPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const elapsed = performance.now() - startedAt;

  if (exitCode !== 0) {
    throw new Error(
      `generate-openapi.ts exited ${exitCode}: ${await new Response(proc.stderr).text()}`,
    );
  }

  return elapsed;
}

benchmarkTest(
  `generate-openapi.ts emits the document in under ${TARGET_MS}ms`,
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "studafy-openapi-"));
    const outPath = path.join(scratch, "openapi.json");

    try {
      // One spawn to warm the filesystem cache for Bun's module graph. Unlike the in-process
      // benchmarks there is no JIT to warm: every iteration is a cold process, which is the honest
      // shape of what CI and a developer actually run.
      for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
        await generate(outPath);
      }

      const samples: number[] = [];
      for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
        samples.push(await generate(outPath));
      }

      // Proof the script did the work: a generator that wrote `{}` would otherwise post an
      // excellent time.
      const document = JSON.parse(await readFile(outPath, "utf8")) as {
        openapi: string;
        paths: Record<string, unknown>;
      };
      expect(document.openapi).toBe("3.1.0");
      expect(Object.keys(document.paths).sort()).toEqual([...EXPECTED_PATHS].sort());

      const median = report("generate-openapi.ts", samples);
      console.log(`openapi generation: ${median.toFixed(1)}ms (target < ${TARGET_MS}ms)`);

      expect(median).toBeLessThan(TARGET_MS);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  120_000,
);
