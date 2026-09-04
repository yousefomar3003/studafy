import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { resolveScienceClass } from "./support/academics";
import { apiLoginAs, bearer, loginInBrowser } from "./support/auth";
import { PERSONAS, personaEmailFor } from "./support/personas";
import { API_BASE_URL } from "./support/ports";

interface GradeSubmission {
  id: string;
  student_id: string;
  status: string;
  updated_at: string;
  grades: { id: string; label: string; updated_at: string }[];
}

/**
 * Journey 4/7: grade submit → approve → publish.
 *
 * Grade entry and submission are teacher-only and have no web UI (mobile-only — see the ST-246
 * journey catalog), so this spec drives them through the real API. Approval is the one step the web
 * app actually renders (`/portal/approvals`, `ApprovalQueuePage.tsx`) and is genuinely browser-driven
 * — the click there is what runs `POST /api/approvals/bulk-decision`, which per
 * `grade-entry-service.ts` chains `submitted → approved → published` atomically: there is no
 * separate "publish" step to click. The final read (published grade visible to the student) is
 * API-only too — that route is hard-scoped to STUDENT/PARENT roles and has no web page.
 */
test.describe("grade submit → approve → publish", () => {
  test("a teacher submits a grade, an admin approves it in the browser, and the student sees it published", async ({
    page,
    request,
  }) => {
    const teacherToken = await apiLoginAs(request, PERSONAS.scienceTeacher);
    const { id: classId, termId } = await resolveScienceClass(request, teacherToken);

    const gradebookRes = await request.get(`${API_BASE_URL}/api/grades/gradebooks`, {
      headers: bearer(teacherToken),
      params: { classId },
    });
    expect(gradebookRes.ok()).toBe(true);
    const { id: gradebookId } = (await gradebookRes.json()) as { id: string };

    const label = `E2E Quiz ${randomUUID().slice(0, 8)}`;
    const assessmentRes = await request.post(
      `${API_BASE_URL}/api/grades/gradebooks/${gradebookId}/assessments`,
      { headers: bearer(teacherToken), data: { label, max_score: 100 } },
    );
    expect(assessmentRes.ok()).toBe(true);
    const { submissions } = (await assessmentRes.json()) as { submissions: GradeSubmission[] };

    // Zaid and Lina (db/seeds/data/assessments.ts) have no prior submission, so their draft rows are
    // freshly created here rather than reusing an already-published one — a clean submit→approve
    // run every time this spec executes.
    const submission = submissions.find((s) => s.status === "draft");
    if (!submission) throw new Error("expected at least one draft submission after seeding drafts");
    const grade = submission.grades.find((g) => g.label === label);
    if (!grade) throw new Error(`expected a "${label}" grade record on the draft submission`);

    const scoreRes = await request.patch(
      `${API_BASE_URL}/api/grades/gradebooks/${gradebookId}/grades`,
      {
        headers: bearer(teacherToken),
        data: { grades: [{ id: grade.id, score: 88, updated_at: grade.updated_at }] },
      },
    );
    expect(scoreRes.ok()).toBe(true);

    // Re-read the submission's own concurrency token rather than reusing the one from before the
    // score PATCH: bulkUpdateGrades touches a child grade row, and submit's 409 GRADE_CONCURRENT_EDIT
    // check is keyed on the *submission's* updated_at, which this deliberately does not assume is
    // untouched by that write.
    const entryRes = await request.get(
      `${API_BASE_URL}/api/grades/gradebooks/${gradebookId}/entry`,
      { headers: bearer(teacherToken), params: { status: "draft" } },
    );
    expect(entryRes.ok()).toBe(true);
    const { submissions: freshDrafts } = (await entryRes.json()) as {
      submissions: GradeSubmission[];
    };
    const freshSubmission = freshDrafts.find((s) => s.id === submission.id);
    if (!freshSubmission) throw new Error("draft submission disappeared after scoring");

    const submitRes = await request.patch(
      `${API_BASE_URL}/api/grades/gradebooks/${gradebookId}/submissions/${submission.id}/submit`,
      { headers: bearer(teacherToken), data: { updated_at: freshSubmission.updated_at } },
    );
    expect(submitRes.ok()).toBe(true);
    const submitted = (await submitRes.json()) as { status: string };
    expect(submitted.status).toBe("submitted");

    // The approver's browser step. Found via the live approval queue rather than a hardcoded student
    // name — the same feed ApprovalQueuePage.tsx renders from, keyed by this submission's own id.
    const adminToken = await apiLoginAs(request, PERSONAS.orgAdmin);
    const queueRes = await request.get(`${API_BASE_URL}/api/approvals/queue`, {
      headers: bearer(adminToken),
    });
    expect(queueRes.ok()).toBe(true);
    const { items } = (await queueRes.json()) as { items: { id: string; summary: string }[] };
    const item = items.find((i) => i.id === submission.id);
    if (!item)
      throw new Error("expected the just-submitted grade submission in the approval queue");

    await loginInBrowser(page, PERSONAS.orgAdmin);
    await page.goto("/portal/approvals");
    const row = page.getByLabel(`Select ${item.summary}`).locator("xpath=ancestor::tr");
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByLabel(`Select ${item.summary}`)).toHaveCount(0, { timeout: 15_000 });

    // The published read: STUDENT/PARENT-only, no web page — see the file header. Whichever student
    // the picked draft belongs to (Zaid or Lina — see the comment above) is who this must sign in
    // as: the route 403s for anyone but the submission's own student (published/routes.ts).
    const profileRes = await request.get(`${API_BASE_URL}/api/students/${submission.student_id}`, {
      headers: bearer(adminToken),
    });
    expect(profileRes.ok()).toBe(true);
    const { first_name, last_name } = (await profileRes.json()) as {
      first_name: string;
      last_name: string;
    };
    const studentToken = await apiLoginAs(request, personaEmailFor(first_name, last_name));

    const publishedRes = await request.get(
      `${API_BASE_URL}/api/grades/published/students/${submission.student_id}/terms/${termId}`,
      { headers: bearer(studentToken) },
    );
    expect(publishedRes.ok()).toBe(true);
    const publishedBody = (await publishedRes.json()) as {
      grades: { label: string; score: number }[];
    };
    expect(publishedBody.grades.some((g) => g.label === label && g.score === 88)).toBe(true);
  });
});
