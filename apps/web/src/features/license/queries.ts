import { isLicensableAudience } from "@studafy/constants";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";

import type { components, operations } from "@studafy/api-client";

/**
 * Reads for the school's license pages (`/portal/license`, docs/billing/feature-licensing.md,
 * session 5): the license and this month's usage, what each tier gives, everyone's seat status,
 * quotes, invoices and payments. Every key sits under {@link SCHOOL_LICENSE_KEY}, so a write can
 * refresh the whole area with one invalidation -- accepting a quote changes the license, the quotes
 * and the invoices at once.
 */

type Schemas = components["schemas"];
export type SchoolLicenseOverview = Schemas["SchoolLicenseOverview"];
export type SchoolLicense = NonNullable<SchoolLicenseOverview["license"]>;
export type LicenseAudience = Schemas["LicenseAudience"];
export type LicenseStatus = Schemas["LicenseStatus"];
export type FeatureUsage = Schemas["LicenseFeatureUsage"];
export type ChangeRequest = Schemas["LicenseChangeRequest"];
export type OfferedTier = Schemas["LicenseOfferedTier"];
export type LicensePerson = Schemas["LicensePerson"];
export type PeopleFilter = Schemas["LicensePeopleFilter"];
export type Quote = Schemas["LicenseQuote"];
export type PriceLine = Schemas["LicensePriceLine"];
export type InvoiceListItem = Schemas["LicenseInvoiceListItem"];
export type InvoiceFilter = Schemas["LicenseInvoiceFilter"];
export type InvoiceDetail = Schemas["LicenseInvoiceDetail"];
export type Receipt = Schemas["LicensePaymentReceipt"];
export type Payment = Schemas["LicensePayment"];
export type LicenseCommitment = Schemas["LicenseCommitment"];
export type StudentAiOverview = Schemas["SchoolAiOptInOverview"];
export type AiOptInWindow = NonNullable<Schemas["AiOptInWindow"]>;
export type AiOptIn = NonNullable<Schemas["AiOptIn"]>;
export type AiOptInStudentRow = Schemas["AiOptInStudentRow"];
export type AiOptInStudentFilter = Schemas["AiOptInStudentFilter"];
type PeopleQuery = NonNullable<operations["listSchoolLicensePeople"]["parameters"]["query"]>;

export const SCHOOL_LICENSE_KEY = ["school-license"] as const;

/** Audiences in the order every license screen lists them. */
export const AUDIENCES: readonly LicenseAudience[] = ["student", "teacher", "parent"];

/**
 * The audiences a license screen lists: those a license sells today (`LICENSABLE_AUDIENCES`, only
 * students until teacher and parent features are built), plus any this license already holds seats
 * in, so a license from before the rule still shows everything it has.
 */
export function shownAudiences(license: SchoolLicense | null | undefined): LicenseAudience[] {
  return AUDIENCES.filter((audience) => {
    if (isLicensableAudience(audience)) return true;
    const held = license?.audiences.find((row) => row.audience === audience)?.purchased ?? 0;
    return held > 0 && (audience !== "parent" || license?.includeFamilyPlus === true);
  });
}

/** "Expiring soon" and "almost full", for the banners and the dashboard tile. */
export const EXPIRING_WITHIN_DAYS = 30;
export const ALMOST_FULL_SHARE = 0.9;
export const PEOPLE_PAGE_SIZE = 50;

export function useSchoolLicenseQuery() {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "overview"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/license");
      if (!data) throw new Error("License returned no data.");
      return data as SchoolLicenseOverview;
    },
  });
}

export function useOfferedTiersQuery() {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "tiers"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/license/tiers");
      if (!data) throw new Error("Tiers returned no data.");
      return data.tiers as OfferedTier[];
    },
  });
}

export interface PeopleFilters {
  audience: LicenseAudience;
  show: PeopleFilter;
  search: string;
  gradeLevelId: string;
  sectionId: string;
  classId: string;
  page: number;
}

export function usePeopleQuery(filters: PeopleFilters) {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "people", filters] as const,
    queryFn: async () => {
      const query: PeopleQuery = {
        audience: filters.audience,
        show: filters.show,
        search: filters.search || undefined,
        // The narrowest scope wins on the server; send only the one picked.
        classId: filters.classId || undefined,
        sectionId: filters.classId ? undefined : filters.sectionId || undefined,
        gradeLevelId:
          filters.classId || filters.sectionId ? undefined : filters.gradeLevelId || undefined,
        limit: PEOPLE_PAGE_SIZE,
        offset: filters.page * PEOPLE_PAGE_SIZE,
      };
      const { data } = await api.GET("/api/school/license/people", { params: { query } });
      if (!data) throw new Error("People returned no data.");
      return data as unknown as { people: LicensePerson[]; total: number };
    },
    placeholderData: keepPreviousData,
  });
}

export function useQuotesQuery() {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "quotes"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/license/quotes");
      if (!data) throw new Error("Quotes returned no data.");
      return data.quotes as Quote[];
    },
  });
}

export function useQuoteQuery(quoteId: string) {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "quote", quoteId] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/license/quotes/{quoteId}", {
        params: { path: { quoteId } },
      });
      if (!data) throw new Error("Quote returned no data.");
      return data as Quote;
    },
  });
}

export function useInvoicesQuery(status: InvoiceFilter) {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "invoices", status] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/license/invoices", {
        params: { query: { status } },
      });
      if (!data) throw new Error("Invoices returned no data.");
      return data.invoices as InvoiceListItem[];
    },
    placeholderData: keepPreviousData,
  });
}

export function useInvoiceQuery(invoiceId: string) {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "invoice", invoiceId] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/license/invoices/{invoiceId}", {
        params: { path: { invoiceId } },
      });
      if (!data) throw new Error("Invoice returned no data.");
      return data as InvoiceDetail;
    },
  });
}

export function usePaymentsQuery() {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "payments"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/license/payments");
      if (!data) throw new Error("Payments returned no data.");
      return data.payments as Payment[];
    },
  });
}

/**
 * Student AI opt-in (`/portal/license/student-ai`, 000235): the licence's student seats, the price
 * parents see and what opting in today costs, the window, the counts, and the automatic seat request.
 */
export function useStudentAiQuery() {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "student-ai"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/school/license/student-ai");
      if (!data) throw new Error("Student AI returned no data.");
      return data as StudentAiOverview;
    },
  });
}

export const STUDENT_AI_PAGE_SIZE = 50;

export interface StudentAiFilters {
  filter: AiOptInStudentFilter;
  search: string;
  gradeLevelId: string;
  sectionId: string;
  page: number;
  /** Rows per page; the transfer picker asks for fewer. */
  limit?: number;
}

export function useStudentAiStudentsQuery(filters: StudentAiFilters, enabled = true) {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "student-ai", "students", filters] as const,
    queryFn: async () => {
      const limit = filters.limit ?? STUDENT_AI_PAGE_SIZE;
      const { data } = await api.GET("/api/school/license/student-ai/students", {
        params: {
          query: {
            filter: filters.filter,
            search: filters.search || undefined,
            // The section is the narrower scope; send only the one picked.
            sectionId: filters.sectionId || undefined,
            gradeLevelId: filters.sectionId ? undefined : filters.gradeLevelId || undefined,
            limit,
            offset: filters.page * limit,
          },
        },
      });
      if (!data) throw new Error("Student AI students returned no data.");
      return data as unknown as { students: AiOptInStudentRow[]; total: number };
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

const SEAT_PAGE = 200;

/**
 * The student seats a Student AI opt-in holds for the year (`programme`): they cannot be
 * unassigned, only transferred or released on the Student AI page once the student leaves. Read a
 * page at a time from the seat list, which is the only place that says so.
 */
export function useProgrammeSeatIdsQuery(enabled: boolean) {
  return useQuery({
    queryKey: [...SCHOOL_LICENSE_KEY, "programme-seats"] as const,
    queryFn: async () => {
      const ids = new Set<string>();
      for (let offset = 0; ; offset += SEAT_PAGE) {
        const { data } = await api.GET("/api/school/license/seats", {
          params: { query: { audience: "student", status: "active", limit: SEAT_PAGE, offset } },
        });
        if (!data) throw new Error("Seats returned no data.");
        const page = data as unknown as { seats: Schemas["LicenseSeat"][]; total: number };
        for (const seat of page.seats) if (seat.programme) ids.add(seat.seatId);
        if (page.seats.length < SEAT_PAGE || offset + SEAT_PAGE >= page.total) break;
      }
      return ids as ReadonlySet<string>;
    },
    enabled,
  });
}

/** Student statuses that mean the student has left the school (their seat can move or end). */
export const LEFT_STUDENT_STATUSES: readonly string[] = ["graduated", "withdrawn", "archived"];

/** Seats left of an audience: purchased minus assigned, never below zero. */
export function seatsLeft(license: SchoolLicense, audience: LicenseAudience): number {
  const row = license.audiences.find((a) => a.audience === audience);
  return Math.max(0, (row?.purchased ?? 0) - (row?.assigned ?? 0));
}

/** Whole days from now until `iso` (negative once past). */
export function daysUntil(iso: string, now: number = Date.now()): number {
  return Math.ceil((Date.parse(iso) - now) / 86_400_000);
}
