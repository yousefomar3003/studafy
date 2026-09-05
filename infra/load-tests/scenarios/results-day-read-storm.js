// Scenario 2 — results-day read storm.
//
// Models the burst of reads right after a term's grades are published: students and parents across
// (potentially many) schools all check `GET /api/grades/published/students/{studentId}/terms/
// {termId}` within the same short window. Unlike scenario 1, this is an open (arrival-rate) model,
// not a closed VU model — a "read storm" is defined by how many requests arrive per second, not by
// how many people are sitting in front of a spinner waiting for a slow server (k6's
// `ramping-arrival-rate` executor keeps issuing requests at the target rate regardless of how long
// each one takes, allocating extra VUs from its pool if responses run slow — that's what makes it
// the right executor for this shape of traffic instead of `ramping-vus`).
//
// This path is Redis-cache-dominated by design (apps/api/src/modules/grades/published/cache.ts,
// PUBLISHED_GRADES_CACHE_TTL_SECONDS = 3600) — most requests in a real storm hit a warm cache, which
// is exactly what config/thresholds.js's tighter `p95Cached` budget is for.
//
// Data: STUDENTS_FILE, a JSON array of { email, accessToken, schoolId, studentId, termId }. The
// token may belong to the student themselves or to a linked parent — both are valid callers of this
// endpoint (apps/api/src/modules/grades/published/routes.ts). See ../data/example-students.json.

import { check } from "k6";
import { SharedArray } from "k6/data";
import http from "k6/http";

import { resolveBaseUrl } from "../config/environments.js";
import { NFR_02_ERROR_RATE, cachedEndpointThresholds } from "../config/thresholds.js";
import { resolveAccessToken } from "../lib/auth.js";
import { taggedParams } from "../lib/http.js";

const BASE_URL = resolveBaseUrl();
const STUDENTS_FILE = __ENV.STUDENTS_FILE || "../data/example-students.json";
// Default assumption, not a measured target: see docs/testing/load-test-scenarios.md's "Threshold
// rationale" for the reasoning and how to size this for a real district rollout instead of one
// school.
const TARGET_RPS = Number(__ENV.TARGET_RPS || 200);
const RAMP_UP = __ENV.RAMP_UP || "2m";
const HOLD = __ENV.HOLD || "10m";
const RAMP_DOWN = __ENV.RAMP_DOWN || "1m";
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || Math.ceil(TARGET_RPS / 2));
const MAX_VUS = Number(__ENV.MAX_VUS || TARGET_RPS * 3);

const students = new SharedArray("students", function () {
  const rows = JSON.parse(open(STUDENTS_FILE));
  if (rows.length === 0) throw new Error(`${STUDENTS_FILE} has no student records`);
  return rows;
});

export const options = {
  scenarios: {
    results_day_read_storm: {
      executor: "ramping-arrival-rate",
      exec: "readPublishedGrades",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { target: TARGET_RPS, duration: RAMP_UP },
        { target: TARGET_RPS, duration: HOLD },
        { target: 0, duration: RAMP_DOWN },
      ],
    },
  },
  thresholds: {
    ...cachedEndpointThresholds("published_grades"),
    http_req_failed: [`rate<${NFR_02_ERROR_RATE.maxFailedRate}`],
    checks: ["rate>0.99"],
  },
};

export function readPublishedGrades() {
  const record = students[Math.floor(Math.random() * students.length)];
  const accessToken = resolveAccessToken(BASE_URL, record);

  const res = http.get(
    `${BASE_URL}/api/grades/published/students/${record.studentId}/terms/${record.termId}`,
    taggedParams(accessToken, "published_grades"),
  );

  check(res, { "published grades: 200": (r) => r.status === 200 });
}
