// Scenario 1 — morning attendance peak.
//
// Models the 08:00-ish window every school day when every homeroom/period-1 teacher opens an
// attendance session and submits their roster within a few minutes of each other. One VU = one
// teacher for the life of the run: it holds one identity, opens a session for one of that teacher's
// classes, submits the roster, then sleeps (walking to the next class / next period) before doing
// it again for another class of theirs.
//
// Endpoints exercised: `POST /api/attendance/sessions` (open, idempotent) and
// `POST /api/attendance/records/batch` (submit, chunked at the API's own 50-record cap —
// apps/api/src/modules/attendance/schemas.ts's `batchRecordAttendanceBodySchema`).
//
// Data: TEACHERS_FILE, a JSON array of
//   { email, accessToken, schoolId, classes: [{ classId, period, studentIds: [...] }] }
// See ../data/example-teachers.json for the shape and docs/testing/load-test-scenarios.md for how
// a real one gets produced. Defaults to the bundled example, which is intentionally tiny — enough
// to prove the script is mechanically correct, nowhere near load scale.

import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import http from "k6/http";

import { resolveBaseUrl } from "../config/environments.js";
import { NFR_02_ERROR_RATE, standardEndpointThresholds } from "../config/thresholds.js";
import { resolveAccessToken } from "../lib/auth.js";
import { pickByVu, taggedParams } from "../lib/http.js";

const BASE_URL = resolveBaseUrl();
const TEACHERS_FILE = __ENV.TEACHERS_FILE || "../data/example-teachers.json";
const TEACHER_VUS = Number(__ENV.TEACHER_VUS || 5000);
const RAMP_UP = __ENV.RAMP_UP || "5m";
const HOLD = __ENV.HOLD || "15m";
const RAMP_DOWN = __ENV.RAMP_DOWN || "3m";
const SLEEP_MIN_S = Number(__ENV.ITERATION_SLEEP_MIN_S || 30);
const SLEEP_MAX_S = Number(__ENV.ITERATION_SLEEP_MAX_S || 90);
const BATCH_CHUNK_SIZE = 50; // batchRecordAttendanceBodySchema's hard max — not a tuning knob.

const teachers = new SharedArray("teachers", function () {
  const rows = JSON.parse(open(TEACHERS_FILE));
  if (rows.length === 0) throw new Error(`${TEACHERS_FILE} has no teacher records`);
  return rows;
});

export const options = {
  scenarios: {
    morning_attendance_peak: {
      executor: "ramping-vus",
      exec: "takeAttendance",
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: TEACHER_VUS },
        { duration: HOLD, target: TEACHER_VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    ...standardEndpointThresholds("attendance_open_session"),
    ...standardEndpointThresholds("attendance_batch_record"),
    http_req_failed: [`rate<${NFR_02_ERROR_RATE.maxFailedRate}`],
    checks: ["rate>0.99"],
  },
};

const ATTENDANCE_STATUSES = [
  "present",
  "present",
  "present",
  "present",
  "absent",
  "late",
  "excused",
];

function pickStatus(seed) {
  return ATTENDANCE_STATUSES[seed % ATTENDANCE_STATUSES.length];
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function chunk(records, size) {
  const out = [];
  for (let i = 0; i < records.length; i += size) out.push(records.slice(i, i + size));
  return out;
}

export function takeAttendance() {
  const teacher = pickByVu(teachers, __VU, 0);
  const accessToken = resolveAccessToken(BASE_URL, teacher);
  const classInfo = teacher.classes[__ITER % teacher.classes.length];

  const openRes = http.post(
    `${BASE_URL}/api/attendance/sessions`,
    JSON.stringify({
      class_id: classInfo.classId,
      session_date: todayIso(),
      period: classInfo.period || 1,
    }),
    taggedParams(accessToken, "attendance_open_session"),
  );
  const opened = check(openRes, {
    "open session: 200 or 201": (r) => r.status === 200 || r.status === 201,
  });
  if (!opened) return;

  const sessionId = openRes.json("id");
  const records = classInfo.studentIds.map((studentId, index) => ({
    student_id: studentId,
    status: pickStatus(index + __ITER),
  }));

  for (const batch of chunk(records, BATCH_CHUNK_SIZE)) {
    const batchRes = http.post(
      `${BASE_URL}/api/attendance/records/batch`,
      JSON.stringify({ attendance_session_id: sessionId, records: batch }),
      taggedParams(accessToken, "attendance_batch_record"),
    );
    check(batchRes, {
      "batch record: 200 or 201": (r) => r.status === 200 || r.status === 201,
    });
  }

  sleep(SLEEP_MIN_S + Math.random() * (SLEEP_MAX_S - SLEEP_MIN_S));
}
