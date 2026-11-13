import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type Scholarship = components["schemas"]["Scholarship"];
export type ScholarshipAward = components["schemas"]["ScholarshipAward"];
export type AwardStatus = ScholarshipAward["status"];
export type CreateScholarshipBody = components["schemas"]["CreateScholarshipBody"];

export const AWARDS_PAGE_SIZE = 20;

/** Every scholarships query sits under this key, so one invalidation refreshes both tables. */
export const SCHOLARSHIPS_KEY = ["finance", "scholarships"] as const;

export async function fetchScholarships(): Promise<Scholarship[]> {
  const { data } = await api.GET("/api/finance/scholarships", {
    params: { query: { limit: 100, offset: 0 } },
  });
  return (data?.scholarships ?? []) as Scholarship[];
}

export async function fetchAwardsPage(
  status: AwardStatus | "",
  offset: number,
): Promise<{ items: ScholarshipAward[]; total: number }> {
  const { data } = await api.GET("/api/finance/scholarship-awards", {
    params: {
      query: { status: status || undefined, limit: AWARDS_PAGE_SIZE, offset },
    },
  });
  return { items: (data?.awards ?? []) as ScholarshipAward[], total: data?.total ?? 0 };
}

/** "10% off all fees", "150.500 JOD off Tuition". */
export function discountSummary(
  t: (key: string, values?: Record<string, unknown>) => string,
  item: Pick<Scholarship, "discount_type" | "percentage" | "amount" | "currency" | "fee_category">,
): string {
  const value =
    item.discount_type === "percentage"
      ? `${Number(item.percentage)}%`
      : `${item.amount ?? ""} ${item.currency ?? ""}`.trim();
  return item.fee_category
    ? t("financeReports.adjustments.scholarships.discountOnCategory", {
        value,
        category: item.fee_category,
      })
    : t("financeReports.adjustments.scholarships.discountOnAll", { value });
}

function useInvalidating<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SCHOLARSHIPS_KEY }),
  });
}

/**
 * Creates the scholarship, then requests an award of it for each of `studentIds` — the same
 * `pending_approval` request "Award to a student" makes, so the school admin still approves each.
 * The scholarship stands even if some requests fail; `failed` counts them for the caller to report.
 */
export function useCreateScholarship() {
  return useInvalidating(
    async ({ body, studentIds = [] }: { body: CreateScholarshipBody; studentIds?: string[] }) => {
      const { data } = await api.POST("/api/finance/scholarships", { body });
      if (!data) throw new Error("Creating the scholarship returned no data.");
      const requests = await Promise.allSettled(
        studentIds.map((studentId) =>
          api.POST("/api/finance/scholarship-awards", {
            body: { scholarship_id: data.id, student_id: studentId },
          }),
        ),
      );
      const failed = requests.filter((result) => result.status === "rejected").length;
      return { scholarship: data, requested: studentIds.length - failed, failed };
    },
  );
}

export function useSetScholarshipActive() {
  return useInvalidating(async ({ id, isActive }: { id: string; isActive: boolean }) => {
    const { data } = await api.PATCH("/api/finance/scholarships/{scholarshipId}", {
      params: { path: { scholarshipId: id } },
      body: { is_active: isActive },
    });
    if (!data) throw new Error("Updating the scholarship returned no data.");
    return data;
  });
}

export function useRequestAward() {
  return useInvalidating(
    async (body: { scholarship_id: string; student_id: string; notes?: string }) => {
      const { data } = await api.POST("/api/finance/scholarship-awards", { body });
      if (!data) throw new Error("Requesting the award returned no data.");
      return data;
    },
  );
}

export type AwardDecision = "approve" | "reject" | "revoke";

export function useDecideAward() {
  return useInvalidating(
    async ({
      awardId,
      decision,
      notes,
    }: {
      awardId: string;
      decision: AwardDecision;
      notes?: string;
    }) => {
      const params = { path: { awardId } };
      const { data } =
        decision === "approve"
          ? await api.POST("/api/finance/scholarship-awards/{awardId}/approve", {
              params,
              body: { notes },
            })
          : decision === "reject"
            ? await api.POST("/api/finance/scholarship-awards/{awardId}/reject", {
                params,
                body: { notes: notes ?? "" },
              })
            : await api.POST("/api/finance/scholarship-awards/{awardId}/revoke", {
                params,
                body: { notes },
              });
      if (!data) throw new Error("The award decision returned no data.");
      return data;
    },
  );
}
