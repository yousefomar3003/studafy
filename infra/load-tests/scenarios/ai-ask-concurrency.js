// Scenario 3 — AI ask concurrency.
//
// Models sustained concurrent use of the Ask AI chat surface
// (`POST /api/ai/students/{studentId}/ask`, apps/api/src/modules/ai/routes/ask-routes.ts): many
// students asking grounded questions at once, each waiting out a full SSE turn before asking again.
//
// This is deliberately NOT modeled at the same scale as scenario 1. Attendance-taking concurrency
// is bounded by "how many teachers are on shift right now"; AI concurrency is bounded by the LLM
// provider's own throughput and by the per-school circuit breaker in
// apps/api/src/modules/ai/llm/routing.ts — a district's entire student body is never asking the
// tutor bot in the same 60-second window the way every homeroom teacher takes attendance in the
// same 15-minute window. AI_CONCURRENT_VUS's default below is a starting assumption to tune against
// real usage telemetry once it exists, not a transcription of a stated target (the ticket names this
// scenario "AI ask concurrency" without a number, unlike scenario 1's explicit "5k concurrent
// teachers" — see docs/testing/load-test-scenarios.md).
//
// k6's core `http` module has no native SSE parsing: `http.post` here blocks until the stream
// closes and returns the whole event sequence as one body string. That is used deliberately rather
// than worked around — k6's own `http_req_waiting` (time to first byte) is a faithful proxy for
// "time to the `sources` event" and `http_req_duration` for "time to a fully streamed answer",
// which are exactly the two numbers NFR-01's AI budget cares about (config/thresholds.js's
// `aiEndpointThresholds`). Reaching for k6's experimental websockets/streams modules to parse
// individual `delta` events would add real complexity for a number this suite does not otherwise
// need: per-token latency, not just first-token and total.
//
// A quota/entitlement rejection (402/403/429 from ai/gate/entitlement-gate.ts) or a grounding
// refusal (a 200 response whose stream carries `event: refusal` instead of an answer) is the system
// behaving correctly under load, not a defect — both are tracked but excluded from `AI_HARD_FAILURE`,
// which is what this scenario's error-rate threshold actually watches.
//
// Data: AI_STUDENTS_FILE, a JSON array of { email, accessToken, studentId, level }. See
// ../data/example-ai-students.json.

import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import http from "k6/http";
import { Rate } from "k6/metrics";

import { resolveBaseUrl } from "../config/environments.js";
import { NFR_02_ERROR_RATE, aiEndpointThresholds } from "../config/thresholds.js";
import { resolveAccessToken } from "../lib/auth.js";
import { pickByVu, taggedParams } from "../lib/http.js";

const BASE_URL = resolveBaseUrl();
const AI_STUDENTS_FILE = __ENV.AI_STUDENTS_FILE || "../data/example-ai-students.json";
const AI_CONCURRENT_VUS = Number(__ENV.AI_CONCURRENT_VUS || 300);
const RAMP_UP = __ENV.RAMP_UP || "3m";
const HOLD = __ENV.HOLD || "10m";
const RAMP_DOWN = __ENV.RAMP_DOWN || "1m";
const THINK_MIN_S = Number(__ENV.THINK_MIN_S || 20);
const THINK_MAX_S = Number(__ENV.THINK_MAX_S || 60);

const students = new SharedArray("aiStudents", function () {
  const rows = JSON.parse(open(AI_STUDENTS_FILE));
  if (rows.length === 0) throw new Error(`${AI_STUDENTS_FILE} has no student records`);
  return rows;
});

// A small, deliberately generic question bank — real question text does not matter to this
// scenario (retrieval/grounding quality is a RAG-eval concern, see apps/api/tests/ai-eval), only
// that a real retrieval + generation round trip runs under load.
const QUESTIONS = [
  "Can you explain how photosynthesis works?",
  "What's the difference between mitosis and meiosis?",
  "How do I solve a quadratic equation by factoring?",
  "What caused the fall of the Roman Empire?",
  "Can you summarize the water cycle?",
];

export const hardFailureRate = new Rate("ai_hard_failure_rate");

export const options = {
  scenarios: {
    ai_ask_concurrency: {
      executor: "ramping-vus",
      exec: "askQuestion",
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: AI_CONCURRENT_VUS },
        { duration: HOLD, target: AI_CONCURRENT_VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    ...aiEndpointThresholds("ai_ask"),
    ai_hard_failure_rate: [`rate<${NFR_02_ERROR_RATE.maxFailedRateAi}`],
  },
};

const GATE_STATUS_CODES = new Set([402, 403, 429]);

export function askQuestion() {
  const student = pickByVu(students, __VU, 0);
  const accessToken = resolveAccessToken(BASE_URL, student);
  const question = QUESTIONS[__ITER % QUESTIONS.length];

  const res = http.post(
    `${BASE_URL}/api/ai/students/${student.studentId}/ask`,
    JSON.stringify({ question, level: student.level || "high" }),
    Object.assign(taggedParams(accessToken, "ai_ask"), { timeout: "60s" }),
  );

  const isGateRejection = GATE_STATUS_CODES.has(res.status);
  const isStreamedOutcome = res.status === 200;
  const body = isStreamedOutcome ? res.body : "";
  const hasDone = body.indexOf("event: done") !== -1 || body.indexOf('"event":"done"') !== -1;
  const hasRefusal = body.indexOf("refusal") !== -1;
  const hasModerationBlock = body.indexOf("moderation_blocked") !== -1;
  const hasStreamError =
    body.indexOf("event: error") !== -1 || body.indexOf('"event":"error"') !== -1;

  check(res, {
    "ask: acceptable outcome (answered, refused, moderated, or gated)": () =>
      hasDone || hasRefusal || hasModerationBlock || isGateRejection,
  });

  // A hard failure is one this system did not intend: a 5xx, a network error, or a 200 stream that
  // neither completed nor produced one of its documented terminal events.
  const isHardFailure =
    !isGateRejection &&
    (res.status === 0 ||
      res.status >= 500 ||
      (isStreamedOutcome && !hasDone && !hasRefusal && !hasModerationBlock) ||
      hasStreamError);
  hardFailureRate.add(isHardFailure);

  sleep(THINK_MIN_S + Math.random() * (THINK_MAX_S - THINK_MIN_S));
}
