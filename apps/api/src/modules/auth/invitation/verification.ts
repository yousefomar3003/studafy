import { createHash, timingSafeEqual } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";

import type { Database } from "../../../db";
import type { ErrorCode } from "@studafy/constants";

export const INVITATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const DUMMY_TOKEN_DIGEST = Buffer.from(
  "7d9e667c7a1a4f7f4e6b8f19be7b4237a734d0d69194c6b1e39b47e97c789f23",
  "hex",
);

export type InvitationVerificationState =
  "VALID" | "EXPIRED" | "REVOKED" | "CONSUMED" | "SCHOOL_SUSPENDED";

type SchoolStatus = "pending" | "active" | "suspended" | "archived";

interface LookupRow {
  found: boolean;
  candidateHash: Buffer;
  normalizedEmail: string;
  expiresAt: Date;
  revokedAt: Date | null;
  consumedAt: Date | null;
  schoolName: string;
  schoolStatus: SchoolStatus;
}

export interface InvitationLifecycleInput {
  expiresAt: Date;
  revokedAt: Date | null;
  consumedAt: Date | null;
  schoolStatus: SchoolStatus;
}

export interface ValidInvitationVerification {
  state: "VALID";
  emailHint: string;
  schoolName: string;
}

export interface FailedInvitationVerification {
  state: Exclude<InvitationVerificationState, "VALID">;
}

export type InvitationVerificationResult =
  ValidInvitationVerification | FailedInvitationVerification;

export interface VerifyInvitationOptions {
  now?: () => number;
}

export interface InvitationTokenResolution {
  authentic: boolean;
  state: InvitationVerificationState;
  emailHint: string;
  schoolName: string;
}

export function hashInvitationToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function invitationHashesMatch(presented: Uint8Array, candidate: Uint8Array): boolean {
  const comparableCandidate = candidate.byteLength === 32 ? candidate : DUMMY_TOKEN_DIGEST;
  const comparablePresented = presented.byteLength === 32 ? presented : DUMMY_TOKEN_DIGEST;
  return timingSafeEqual(comparablePresented, comparableCandidate);
}

export function evaluateInvitationState(
  invitation: InvitationLifecycleInput,
  now = Date.now(),
): InvitationVerificationState {
  if (invitation.expiresAt.getTime() <= now) return "EXPIRED";
  if (invitation.revokedAt !== null) return "REVOKED";
  if (invitation.consumedAt !== null) return "CONSUMED";
  if (invitation.schoolStatus !== "active") return "SCHOOL_SUSPENDED";
  return "VALID";
}

export function maskInvitationEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1) return "***";

  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

function failureCode(state: Exclude<InvitationVerificationState, "VALID">): ErrorCode {
  switch (state) {
    case "EXPIRED":
      return ERROR_CODES.EXPIRED;
    case "REVOKED":
      return ERROR_CODES.REVOKED;
    case "CONSUMED":
      return ERROR_CODES.CONSUMED;
    case "SCHOOL_SUSPENDED":
      return ERROR_CODES.SCHOOL_SUSPENDED;
  }
}

export function throwInvitationVerificationFailure(result: FailedInvitationVerification): never {
  throw new CodedHttpException(409, failureCode(result.state), "Invitation cannot be used.");
}

export async function resolveInvitationToken(
  database: Database,
  rawToken: string,
  options: VerifyInvitationOptions = {},
): Promise<InvitationTokenResolution> {
  const formatValid = INVITATION_TOKEN_PATTERN.test(rawToken);
  const presentedHash = formatValid ? hashInvitationToken(rawToken) : DUMMY_TOKEN_DIGEST;

  let row: LookupRow | undefined;
  await database.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    const rows = await tx<LookupRow[]>`
      SELECT
        found,
        candidate_hash AS "candidateHash",
        normalized_email AS "normalizedEmail",
        expires_at AS "expiresAt",
        revoked_at AS "revokedAt",
        consumed_at AS "consumedAt",
        school_name AS "schoolName",
        school_status AS "schoolStatus"
      FROM app.lookup_invitation_for_verification(${presentedHash}::bytea)
    `;
    row = rows[0];
  });

  if (!row) {
    throw new Error("invitation verification lookup returned no row");
  }

  const hashMatches = invitationHashesMatch(presentedHash, Buffer.from(row.candidateHash));

  // Perform the same public-projection and lifecycle work for real and dummy rows before deciding
  // whether the lookup was authentic. This keeps the service path structurally uniform.
  const emailHint = maskInvitationEmail(row.normalizedEmail);
  const state = evaluateInvitationState(
    {
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      consumedAt: row.consumedAt,
      schoolStatus: row.schoolStatus,
    },
    options.now?.() ?? Date.now(),
  );

  return {
    authentic: formatValid && row.found && hashMatches,
    state,
    emailHint,
    schoolName: row.schoolName,
  };
}

export async function verifyInvitationToken(
  database: Database,
  rawToken: string,
  options: VerifyInvitationOptions = {},
): Promise<InvitationVerificationResult> {
  const resolution = await resolveInvitationToken(database, rawToken, options);

  if (!resolution.authentic) {
    throw new CodedHttpException(400, ERROR_CODES.INVITATION_INVALID, "Invitation is invalid.");
  }

  if (resolution.state !== "VALID") return { state: resolution.state };
  return {
    state: resolution.state,
    emailHint: resolution.emailHint,
    schoolName: resolution.schoolName,
  };
}
