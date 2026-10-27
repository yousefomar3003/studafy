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
type PeopleQuery = NonNullable<operations["listSchoolLicensePeople"]["parameters"]["query"]>;

export const SCHOOL_LICENSE_KEY = ["school-license"] as const;

/** Audiences in the order every license screen lists them. */
export const AUDIENCES: readonly LicenseAudience[] = ["student", "teacher", "parent"];

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

/** Seats left of an audience: purchased minus assigned, never below zero. */
export function seatsLeft(license: SchoolLicense, audience: LicenseAudience): number {
  const row = license.audiences.find((a) => a.audience === audience);
  return Math.max(0, (row?.purchased ?? 0) - (row?.assigned ?? 0));
}

/** Whole days from now until `iso` (negative once past). */
export function daysUntil(iso: string, now: number = Date.now()): number {
  return Math.ceil((Date.parse(iso) - now) / 86_400_000);
}
