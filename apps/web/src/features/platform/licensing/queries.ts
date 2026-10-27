import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { PLATFORM_KEY } from "../queries";

import type { components, operations } from "@studafy/api-client";

/**
 * Reads for the license console (docs/billing/feature-licensing.md, session 4): the feature
 * catalog, tiers, pricing, quotes, licenses, invoices and payments. Every key sits under
 * {@link LICENSING_KEY}, so a write can refresh the whole console with one invalidation -- the
 * figures are linked (a payment moves an invoice, a license, the finance totals and the overview).
 */

type Schemas = components["schemas"];
export type ConsoleFeature = Schemas["ConsoleFeature"];
export type FeatureStatus = Schemas["FeatureStatus"];
export type ConsoleTier = Schemas["ConsoleTier"];
export type LicenseAudience = Schemas["LicenseAudience"];
export type LicenseStatus = Schemas["LicenseStatus"];
export type PriceSettings = Schemas["LicensePriceSettings"];
export type BankDetails = NonNullable<Schemas["LicenseBankDetails"]>;
export type QuoteCalculation = Schemas["LicenseQuoteCalculation"];
export type QuoteCalculateBody = Schemas["LicenseQuoteCalculateBody"];
export type PriceLine = Schemas["LicensePriceLine"];
export type Quote = Schemas["LicenseQuote"];
export type QuoteStatus = Schemas["LicenseQuoteStatus"];
export type ConsoleLicense = Schemas["ConsoleLicense"];
export type PlatformLicense = Schemas["PlatformSchoolLicense"];
export type ChangeRequest = Schemas["ConsoleChangeRequest"];
export type SchoolLicenseConsole = Schemas["SchoolLicenseConsole"];
export type UsageRevenue = Schemas["ConsoleUsageRevenue"];
export type InvoiceListItem = Schemas["PlatformLicenseInvoiceListItem"];
export type InvoiceDetail = Schemas["LicenseInvoiceDetail"];
export type InvoiceFilter = Schemas["LicenseInvoiceFilter"];
export type Payment = Schemas["LicensePayment"];
export type PendingReceipt = Schemas["LicensePendingReceipt"];
export type FinanceOverview = Schemas["LicenseFinanceOverview"];
export type Seat = Schemas["LicenseSeat"];
type SeatQuery = NonNullable<operations["platformListLicenseSeats"]["parameters"]["query"]>;

export const LICENSING_KEY = [...PLATFORM_KEY, "licensing"] as const;

export function useConsoleFeaturesQuery() {
  return useQuery({
    queryKey: [...LICENSING_KEY, "features"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/features");
      if (!data) throw new Error("Feature list returned no data.");
      return data.features as ConsoleFeature[];
    },
  });
}

export function useTiersQuery() {
  return useQuery({
    queryKey: [...LICENSING_KEY, "tiers"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/tiers");
      if (!data) throw new Error("Tier list returned no data.");
      return data.tiers as ConsoleTier[];
    },
  });
}

export function usePriceSettingsQuery() {
  return useQuery({
    queryKey: [...LICENSING_KEY, "price-settings"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/licenses/price-settings");
      if (!data) throw new Error("Price settings returned no data.");
      return data.settings as PriceSettings[];
    },
  });
}

export function useBankDetailsQuery() {
  return useQuery({
    queryKey: [...LICENSING_KEY, "bank-details"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/licenses/bank-details");
      if (!data) throw new Error("Bank details returned no data.");
      return data.bankDetails as BankDetails | null;
    },
  });
}

/**
 * The calculator: `POST /api/platform/licenses/quote` prices without saving, so it is a read. Off
 * until the terms are complete enough to price (`body` null).
 */
export function useCalculationQuery(body: QuoteCalculateBody | null) {
  return useQuery({
    queryKey: [...LICENSING_KEY, "calculation", body] as const,
    queryFn: async () => {
      const { data } = await api.POST("/api/platform/licenses/quote", { body: body! });
      if (!data) throw new Error("The calculator returned no data.");
      return data as QuoteCalculation;
    },
    enabled: body !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useSchoolQuotesQuery(schoolId: string | null) {
  return useQuery({
    queryKey: [...LICENSING_KEY, "quotes", schoolId] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/license-quotes", {
        params: { path: { schoolId: schoolId! } },
      });
      if (!data) throw new Error("Quote list returned no data.");
      return data.quotes as Quote[];
    },
    enabled: schoolId !== null,
  });
}

export interface LicenseListFilters {
  status: LicenseStatus | "";
  expiring: boolean;
  nearlyFull: boolean;
  unpaid: boolean;
}

/** "Expiring" is within 30 days; "nearly full" is some audience at 90% of its seats or more. */
export const EXPIRING_WITHIN_DAYS = 30;
export const NEARLY_FULL_SHARE = 0.9;

export function useLicensesQuery(filters: LicenseListFilters) {
  return useQuery({
    queryKey: [...LICENSING_KEY, "licenses", filters] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/licenses", {
        params: {
          query: {
            status: filters.status || undefined,
            expiringWithinDays: filters.expiring ? EXPIRING_WITHIN_DAYS : undefined,
            seatsNearlyFull: filters.nearlyFull ? NEARLY_FULL_SHARE : undefined,
            unpaid: filters.unpaid ? "true" : undefined,
          },
        },
      });
      if (!data) throw new Error("License list returned no data.");
      return data.licenses as ConsoleLicense[];
    },
    placeholderData: keepPreviousData,
  });
}

export function useChangeRequestsQuery(status: ChangeRequest["status"] | "") {
  return useQuery({
    queryKey: [...LICENSING_KEY, "change-requests", status] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/licenses/change-requests", {
        params: { query: { status: status || undefined } },
      });
      if (!data) throw new Error("Change requests returned no data.");
      return data.requests as ChangeRequest[];
    },
  });
}

export function useUsageRevenueQuery() {
  return useQuery({
    queryKey: [...LICENSING_KEY, "usage"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/licenses/usage");
      if (!data) throw new Error("Usage returned no data.");
      return data as UsageRevenue;
    },
  });
}

export function useSchoolLicenseConsoleQuery(schoolId: string) {
  return useQuery({
    queryKey: [...LICENSING_KEY, "school", schoolId] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/license-console", {
        params: { path: { schoolId } },
      });
      if (!data) throw new Error("School license returned no data.");
      return data as SchoolLicenseConsole;
    },
  });
}

export function useLicenseSeatsQuery(
  schoolId: string,
  licenseId: string | null,
  filters: { audience: SeatQuery["audience"]; search: string },
) {
  return useQuery({
    queryKey: [...LICENSING_KEY, "seats", schoolId, licenseId, filters] as const,
    queryFn: async () => {
      const { data } = await api.GET(
        "/api/platform/schools/{schoolId}/licenses/{licenseId}/seats",
        {
          params: {
            path: { schoolId, licenseId: licenseId! },
            query: {
              audience: filters.audience,
              search: filters.search || undefined,
              status: "active",
              limit: 200,
            },
          },
        },
      );
      if (!data) throw new Error("Seat list returned no data.");
      return data as unknown as { seats: Seat[]; total: number };
    },
    enabled: licenseId !== null,
    placeholderData: keepPreviousData,
  });
}

export interface InvoiceListFilters {
  status: InvoiceFilter;
  schoolId: string;
  from: string;
  to: string;
}

export function useInvoicesQuery(filters: InvoiceListFilters) {
  return useQuery({
    queryKey: [...LICENSING_KEY, "invoices", filters] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/licenses/invoices", {
        params: {
          query: {
            status: filters.status,
            schoolId: filters.schoolId || undefined,
            from: filters.from || undefined,
            to: filters.to || undefined,
          },
        },
      });
      if (!data) throw new Error("Invoice list returned no data.");
      return data.invoices as InvoiceListItem[];
    },
    placeholderData: keepPreviousData,
  });
}

export function useInvoiceQuery(schoolId: string, invoiceId: string) {
  return useQuery({
    queryKey: [...LICENSING_KEY, "invoice", schoolId, invoiceId] as const,
    queryFn: async () => {
      const { data } = await api.GET(
        "/api/platform/schools/{schoolId}/license-invoices/{invoiceId}",
        { params: { path: { schoolId, invoiceId } } },
      );
      if (!data) throw new Error("Invoice returned no data.");
      return data as InvoiceDetail;
    },
  });
}

export function usePendingReceiptsQuery() {
  return useQuery({
    queryKey: [...LICENSING_KEY, "receipts"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/licenses/receipts");
      if (!data) throw new Error("Receipt list returned no data.");
      return data.receipts as PendingReceipt[];
    },
  });
}

export function useLicenseFinanceQuery() {
  return useQuery({
    queryKey: [...LICENSING_KEY, "finance"] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/licenses/finance");
      if (!data) throw new Error("Finance totals returned no data.");
      return data as FinanceOverview;
    },
  });
}

/** A school's licenses, newest first (the calculator's license picker for changes). */
export function useSchoolLicensesQuery(schoolId: string | null) {
  return useQuery({
    queryKey: [...LICENSING_KEY, "school-licenses", schoolId] as const,
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/licenses", {
        params: { path: { schoolId: schoolId! } },
      });
      if (!data) throw new Error("License list returned no data.");
      return data.licenses as unknown as PlatformLicense[];
    },
    enabled: schoolId !== null,
  });
}
