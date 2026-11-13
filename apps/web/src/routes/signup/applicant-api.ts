import { ApiError, createApiClient } from "@studafy/api-client";
import { useQuery } from "@tanstack/react-query";

import { API_BASE_URL } from "../../lib/config";

import type { components } from "@studafy/api-client";

export type ApplicantMe = components["schemas"]["ApplicantMe"];
export type ApplicantApplication = NonNullable<ApplicantMe["application"]>;
export type SignupProvider = "google" | "microsoft";

/**
 * The applicant's own API client. An applicant has signed in with Google or Microsoft but has no
 * Studafy session, so there is no bearer token: the API authenticates them by the HttpOnly
 * applicant cookie set by the sign-up OAuth callback, which `credentials: "include"` sends
 * cross-origin (see apps/api/src/modules/school-applications/applicant-session.ts).
 */
export const applicantApi = createApiClient({ baseUrl: API_BASE_URL, credentials: "include" });

/** Full-page redirect target that starts Google/Microsoft sign-in for a new school application. */
export function signupOAuthStartUrl(provider: SignupProvider): string {
  return `${API_BASE_URL}/api/auth/oauth/${provider}/school-application/start`;
}

export const APPLICANT_KEY = ["school-applicant"] as const;

/**
 * `GET /api/school-applications/me`. Resolves to null when there is no applicant session (401),
 * so pages can branch on "signed in or not" without treating it as an error.
 */
export function useApplicantQuery() {
  return useQuery({
    queryKey: APPLICANT_KEY,
    queryFn: async (): Promise<ApplicantMe | null> => {
      try {
        const { data } = await applicantApi.GET("/api/school-applications/me");
        return (data as ApplicantMe | undefined) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });
}
