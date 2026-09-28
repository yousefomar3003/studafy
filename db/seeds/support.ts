// Shared types and small deterministic helpers for the demo-tenant seed. Everything here is pure and
// side-effect free; the SQL work lives in the data/* modules. The context objects are composed
// functionally (seedSchool -> seedPeople -> seedAcademics -> ...) so each stage only ever sees the
// pieces earlier stages have already produced, and no field is read before it is assigned.
import { randomUUID } from "node:crypto";

import type { MockPersona } from "./mock-credentials";
import type { ReservedSql } from "../../packages/db/src/client";

// The seed runs on a single reserved connection inside one transaction (see seed.ts). Every data
// module receives this same handle.
export type Sql = ReservedSql;

// Everything that differs between the tenants this directory can seed: the local demo tenant
// (seed.ts) and the App Store / Play reviewer tenant (review-tenant.ts). The data modules are shared;
// only this profile changes.
export interface TenantProfile {
  readonly slug: string;
  readonly name: string;
  // Sets app.schools.is_review_tenant (migration 000116): non-billable, and the only school the
  // review email/password login accepts.
  readonly isReviewTenant: boolean;
  readonly plan: {
    readonly code: string;
    readonly displayName: string;
    readonly description: string;
    // An inactive plan is never offered at checkout or listed to schools.
    readonly isActive: boolean;
    // Monthly price in minor units, or null for a plan with no price row.
    readonly monthlyAmountMinor: number | null;
  };
  readonly personas: readonly MockPersona[];
  // The (provider, subject) a persona signs in with, or null for a roster-only account that has no
  // login at all.
  readonly loginIdentity: (persona: MockPersona) => { provider: string; subject: string } | null;
  // Push-device registrations with fake FCM tokens and pending outbox events. Local only: in a
  // deployed environment the push sender and outbox relay would act on them.
  readonly localFixtures: boolean;
}

export interface SeededPerson {
  readonly key: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface SeededTeacher extends SeededPerson {
  readonly teacherId: string;
}

export interface SeededStudent extends SeededPerson {
  readonly studentId: string;
  readonly admissionNumber: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface SeededTerm {
  readonly id: string;
  readonly code: string;
  readonly sequence: number;
}

export interface SeededSubject {
  readonly id: string;
  readonly code: string;
}

export interface SeededCourse {
  readonly id: string;
  readonly code: string;
  readonly subjectId: string;
}

export interface SeededRoom {
  readonly id: string;
  readonly code: string;
}

export interface SeededClass {
  readonly id: string;
  readonly code: string;
  readonly courseId: string;
  readonly termId: string;
  readonly academicYearId: string;
  readonly leadTeacherId: string;
  readonly roomId: string;
}

export interface SchoolCtx {
  readonly schoolId: string;
  readonly schoolSlug: string;
  readonly countryId: string;
  readonly currencyId: string;
  readonly planId: string;
}

export interface PeopleCtx {
  readonly orgAdmin: SeededPerson;
  readonly teachers: readonly SeededTeacher[];
  readonly students: readonly SeededStudent[];
  readonly parents: readonly SeededPerson[];
}

export interface SeededEnrollment {
  readonly classId: string;
  readonly studentId: string;
}

export interface AcademicsCtx {
  readonly academicYearId: string;
  readonly terms: readonly SeededTerm[];
  readonly subjects: readonly SeededSubject[];
  readonly courses: readonly SeededCourse[];
  readonly rooms: readonly SeededRoom[];
  readonly classes: readonly SeededClass[];
  readonly enrollments: readonly SeededEnrollment[];
}

export type FullCtx = SchoolCtx & PeopleCtx & AcademicsCtx;

export interface MaterialsCtx {
  // (chunkId, schoolId is implicit) captured so the AI module can cite real chunks.
  readonly chunkIds: readonly string[];
}

// The seeded school's contact address (app.schools.email).
export function schoolContactEmail(slug: string): string {
  return `${slug}@admin.local`;
}

export function uuid(): string {
  return randomUUID();
}

// A deterministic, unit-scale pseudo-embedding. Real embeddings come from a model; for a demo corpus
// the only requirements are: exactly 1536 finite floats (the app.material_chunks vector(1536) type),
// stable across runs, and distinct per chunk so cosine distances are not all identical. Formatted as a
// pgvector text literal ("[v0,v1,...]").
export function deterministicEmbedding(seed: number, dimensions = 1536): string {
  const parts = new Array<string>(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    parts[index] = Math.sin(seed * 0.017 + index * 0.013).toFixed(6);
  }
  return `[${parts.join(",")}]`;
}

// Fixed clock anchor for the demo dataset. The attendance and audit-log partitions shipped by the
// migrations cover 2026-06..2027-01, so every dated row is placed inside that window regardless of the
// wall clock when the seed is run. Kept at .000 milliseconds because attendance foreign keys compare
// created_at for equality at the driver's millisecond transport precision (see migration 000012).
export const SEED_EPOCH = new Date("2026-07-06T08:00:00.000Z");

export function seedDate(dayOffset: number, hour = 8): Date {
  const date = new Date(SEED_EPOCH);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}
