import { createFeatureService } from "../service";

import type { Logger } from "../../../logger";
import type {
  AiEntitlement,
  SchoolEntitlement,
  UserEntitlement,
} from "../../subscriptions/entitlements/resolve";
import type { FeatureCatalog, FeatureCatalogSource } from "../catalog";
import type { FeatureService } from "../service";
import type { FeatureUsageMeter } from "../usage";
import type { FeatureKey } from "@studafy/constants";

/**
 * Fakes for unit tests of the feature service, requireFeature and the routes behind it. The service
 * under test is always the real one (createFeatureService); only its inputs -- the cached
 * entitlements, the catalog and the usage ledger -- are faked.
 */

export const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
export const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
export const USER_ID = "00000000-0000-4000-8000-000000000003";
export const PERIOD_START = "2026-08-01T00:00:00.000Z";
export const PERIOD_END = "2026-08-31T23:59:59.000Z";

export const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

/** The catalog migration 000161 produces: the five features, and ai_addon as the one tier. */
export function migratedCatalog(): FeatureCatalog {
  return {
    settings: {
      ai_tutor: { displayName: "AI tutor", status: "active" },
      study_tools: { displayName: "Study tools", status: "active" },
      notebook: { displayName: "Notebook", status: "active" },
      auto_grading: { displayName: "Auto grading", status: "active" },
      family_plus: { displayName: "Family+", status: "active" },
    },
    tiers: {
      ai_addon: {
        id: "plan-ai-addon",
        code: "ai_addon",
        audience: "student",
        rank: 1,
        includesAllFeatures: false,
        isActive: true,
        limits: { ai_tutor: null, study_tools: null, notebook: null },
      },
    },
  };
}

export function staticCatalog(catalog: FeatureCatalog = migratedCatalog()): FeatureCatalogSource {
  return { get: async () => catalog };
}

export function schoolEntitlement(active: boolean): SchoolEntitlement {
  return {
    schoolId: SCHOOL_ID,
    version: 1,
    subscriptionId: "sub-1",
    status: active ? "active" : "closed",
    active,
    planCode: "free",
    quotas: { studentCap: 50 },
    currentPeriodEnd: PERIOD_END,
  };
}

/** The AI add-on verdict. `status: null` is a student who never bought it. */
export function aiEntitlement(
  status: AiEntitlement["status"],
  overrides: Partial<AiEntitlement> = {},
): AiEntitlement {
  return {
    schoolId: SCHOOL_ID,
    studentId: STUDENT_ID,
    userId: USER_ID,
    version: 1,
    schoolVersion: 1,
    status,
    active: status === "active" || status === "trialing",
    currentPeriodStart: status ? PERIOD_START : null,
    currentPeriodEnd: status ? PERIOD_END : null,
    ...overrides,
  };
}

export function userEntitlement(overrides: Partial<UserEntitlement> = {}): UserEntitlement {
  return {
    schoolId: SCHOOL_ID,
    userId: USER_ID,
    version: 1,
    schoolVersion: 1,
    studentId: STUDENT_ID,
    subscriptions: [],
    seats: [],
    ...overrides,
  };
}

export interface FakeEntitlements {
  school(schoolId: string): Promise<SchoolEntitlement>;
  ai(schoolId: string, studentId: string): Promise<AiEntitlement>;
  user(schoolId: string, userId: string): Promise<UserEntitlement>;
  calls: { ai: string[]; user: string[] };
}

export function fakeEntitlements(input: {
  school?: SchoolEntitlement;
  ai?: AiEntitlement;
  user?: UserEntitlement;
}): FakeEntitlements {
  const calls = { ai: [] as string[], user: [] as string[] };
  return {
    calls,
    school: async () => input.school ?? schoolEntitlement(true),
    ai: async (_schoolId, studentId) => {
      calls.ai.push(studentId);
      return input.ai ?? aiEntitlement(null);
    },
    user: async (_schoolId, userId) => {
      calls.user.push(userId);
      return input.user ?? userEntitlement();
    },
  };
}

export interface MemoryUsageMeter extends FeatureUsageMeter {
  used: Map<string, number>;
  calls: { consume: number; refund: number };
}

/** An in-memory ledger with the database meter's semantics (atomic test-and-add, floor at zero). */
export function memoryUsageMeter(): MemoryUsageMeter {
  const used = new Map<string, number>();
  const calls = { consume: 0, refund: 0 };
  const keyOf = (userId: string, key: FeatureKey) => `${userId}:${key}`;
  const periodStart = "2026-08-01";

  return {
    used,
    calls,
    async consume({ userId, key, amount, limit }) {
      calls.consume += 1;
      const current = used.get(keyOf(userId, key)) ?? 0;
      if (limit !== null && current + amount > limit) {
        return { ok: false, used: current, periodStart };
      }
      used.set(keyOf(userId, key), current + amount);
      return { ok: true, used: current + amount, periodStart };
    },
    async refund({ userId, key, amount }) {
      calls.refund += 1;
      const current = used.get(keyOf(userId, key)) ?? 0;
      used.set(keyOf(userId, key), Math.max(0, current - amount));
    },
    async read(_schoolId, userId) {
      const usage: Partial<Record<FeatureKey, number>> = {};
      for (const [composite, value] of used) {
        const [owner, key] = composite.split(":") as [string, FeatureKey];
        if (owner === userId) usage[key] = value;
      }
      return usage;
    },
  };
}

/** The real feature service over fakes. */
export function fakeFeatureService(
  input: {
    entitlements?: FakeEntitlements;
    catalog?: FeatureCatalog;
    usage?: FeatureUsageMeter;
  } = {},
): FeatureService {
  return createFeatureService({
    // Never reached: catalog and usage are injected.
    database: (() => {
      throw new Error("fakeFeatureService touched the database");
    }) as never,
    entitlements: input.entitlements ?? fakeEntitlements({}),
    logger: silentLogger,
    catalog: staticCatalog(input.catalog),
    usage: input.usage ?? memoryUsageMeter(),
  });
}

/**
 * A feature service in which the student in every AI route's path holds the AI add-on: what an AI
 * route test needs to reach its handler.
 */
export function aiSubscriberFeatureService(): FeatureService {
  return fakeFeatureService({
    entitlements: fakeEntitlements({ ai: aiEntitlement("active") }),
  });
}
