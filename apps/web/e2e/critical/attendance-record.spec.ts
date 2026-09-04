import { expect, test } from "@playwright/test";

import { resolveScienceClass } from "./support/academics";
import { apiLoginAs, bearer, loginInBrowser } from "./support/auth";
import { uniqueFutureIsoDate } from "./support/dates";
import { PERSONAS } from "./support/personas";
import { API_BASE_URL } from "./support/ports";

/**
 * Journey 3/7: attendance record.
 *
 * The web app has no "take attendance" screen at all — opening a session and marking a roster is
 * teacher-only and exists only in the Flutter mobile app (see the ST-246 journey catalog). This spec
 * drives that half through the real API, as a mobile client would, then switches to the browser for
 * the half that *does* have a web surface: the admin-facing attendance oversight dashboard
 * (`/portal/principal/attendance`), which is a live report over the same database this test just
 * wrote to.
 */
test.describe("attendance record", () => {
  test("a teacher opens a session and records attendance; an admin can reach the oversight dashboard", async ({
    page,
    request,
  }) => {
    const teacherToken = await apiLoginAs(request, PERSONAS.scienceTeacher);
    const { id: classId } = await resolveScienceClass(request, teacherToken);

    const openRes = await request.post(`${API_BASE_URL}/api/attendance/sessions`, {
      headers: bearer(teacherToken),
      data: { class_id: classId, session_date: uniqueFutureIsoDate() },
    });
    expect([200, 201]).toContain(openRes.status());
    const session = (await openRes.json()) as { id: string; status: string };
    expect(session.status).toBe("open");

    const rosterRes = await request.get(
      `${API_BASE_URL}/api/academics/classes/${classId}/enrollments`,
      { headers: bearer(teacherToken), params: { status: "active", limit: "100" } },
    );
    expect(rosterRes.ok()).toBe(true);
    const roster = (await rosterRes.json()) as { enrollments: { student_id: string }[] };
    expect(roster.enrollments.length).toBeGreaterThan(0);

    const records = roster.enrollments.map((enrollment, index) => ({
      student_id: enrollment.student_id,
      status: index === 0 ? "absent" : "present",
    }));

    const recordRes = await request.post(`${API_BASE_URL}/api/attendance/records/batch`, {
      headers: bearer(teacherToken),
      data: { attendance_session_id: session.id, records },
    });
    expect([200, 201]).toContain(recordRes.status());
    const recorded = (await recordRes.json()) as { created_count: number; total_count: number };
    expect(recorded.created_count).toBe(roster.enrollments.length);
    expect(recorded.total_count).toBe(roster.enrollments.length);

    // A replay of the same batch is idempotent — the honest proof this wrote real, durable state
    // rather than something a second call would happily duplicate.
    const replayRes = await request.post(`${API_BASE_URL}/api/attendance/records/batch`, {
      headers: bearer(teacherToken),
      data: { attendance_session_id: session.id, records },
    });
    expect([200, 201]).toContain(replayRes.status());
    const replayed = (await replayRes.json()) as { created_count: number };
    expect(replayed.created_count).toBe(0);

    await loginInBrowser(page, PERSONAS.orgAdmin);
    await page.goto("/portal/principal/attendance");
    // Proof the real page rendered past the permission guard and the live report queries: the
    // student-search filter (AttendanceDashboardView.tsx) only mounts once matrix/metadata data has
    // loaded from the real API.
    await expect(page.getByLabel("Student search")).toBeVisible();
  });
});
