/**
 * Public "Talk to us" submissions. A prospective school's contact details land in the global
 * `app.sales_inquiries` table (studafy_admin only, see migration 000125); the platform console
 * lists and works them, and the worker's email dispatcher notifies the sales inbox.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { withSystemTx } from "../../db/tenant-tx";
import { verifyCaptcha } from "../tenancy/registration/captcha";

import type { Database } from "../../db/client";

export interface SubmitInquiryParams {
  fullName: string;
  email: string;
  phone?: string;
  schoolName: string;
  jobTitle?: string;
  country?: string;
  studentCount?: number;
  message?: string;
  sourcePath?: string;
  captchaToken: string;
  clientIp: string | null;
}

export interface SubmitInquiryDeps {
  database: Database;
  /** Absent in development, where verifyCaptcha accepts any token. */
  captchaSecretKey: string | undefined;
}

export async function submitInquiry(
  deps: SubmitInquiryDeps,
  params: SubmitInquiryParams,
): Promise<{ id: string }> {
  const captchaValid = await verifyCaptcha(
    params.captchaToken,
    deps.captchaSecretKey,
    params.clientIp ?? undefined,
  );
  if (!captchaValid) {
    throw new CodedHttpException(400, ERROR_CODES.CAPTCHA_INVALID, "Captcha verification failed.");
  }

  return withSystemTx(deps.database, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.sales_inquiries (
        full_name, email, phone, school_name, job_title, country, student_count, message,
        source_path
      ) VALUES (
        ${params.fullName}, ${params.email.toLowerCase()}, ${params.phone ?? null},
        ${params.schoolName}, ${params.jobTitle ?? null}, ${params.country ?? null},
        ${params.studentCount ?? null}, ${params.message ?? null}, ${params.sourcePath ?? null}
      )
      RETURNING id
    `;
    return { id: row!.id };
  });
}
