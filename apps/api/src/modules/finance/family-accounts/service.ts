/**
 * Families, as finance sees them: one household per row, with its guardians, its children (and
 * which of them the sibling rule discounts), and what it owes across every child's invoices.
 *
 * The parent-facing household view (`../family/service.ts`) answers "what does my family owe"; this
 * answers "which families owe what", and is the only place finance can act on a family as a whole:
 * one payment split across the children's invoices, a reminder, a statement.
 *
 * Reads run as `studafy_admin` with the tenant scope set (withStudentIdentityTx): FINANCE holds no
 * `student:read` and cannot see app.students or the guardians' links under its role-scope policies,
 * yet a family is meaningless without its members. Only identity columns (names, admission numbers,
 * emails) and money from the local finance read models leave this module.
 *
 * Money is per currency throughout and never summed across currencies, the same rule the household
 * view follows. Invoices in `draft` or `cancelled` state are not the family's debt and are ignored.
 */

import { createHash } from "node:crypto";

import {
  loadSiblingDiscountRule,
  loadSiblingStandings,
  siblingPercentageFor,
} from "@studafy/billing";
import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { listFamilyCommunications } from "../communications/service";
import { formatMinorUnits, getCurrencyByCode, toMinorUnits } from "../currency";
import { createPayment } from "../payments/service";
import { withStudentIdentityTx } from "../students/service";

import type { CreateFamilyPaymentBody, FamilyListQuery } from "./schemas";
import type { Database } from "../../../db/client";
import type { TenantContext } from "../../../db/tenant-tx";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { CommunicationRow } from "../communications/service";
import type { PaymentRow } from "../payments/service";
import type { TransactionSql } from "postgres";

export interface FinanceFamily {
  id: string;
  display_name: string;
  guardians: { user_id: string; name: string; email: string; is_primary: boolean }[];
  children: {
    student_id: string;
    name: string;
    admission_number: string;
    status: string;
    child_position: number | null;
    sibling_discount_percentage: number | null;
  }[];
  balances: {
    currency: string;
    currency_minor_unit: number;
    billed: string;
    billed_minor: number;
    outstanding: string;
    outstanding_minor: number;
    overdue: string;
    overdue_minor: number;
  }[];
  overdue_invoice_count: number;
  last_payment_date: string | null;
  last_reminder_at: string | null;
}

/** An invoice counts toward a family's debt unless it never became one. */
const LIVE_INVOICE = "lower(ic.erpnext_status) NOT IN ('draft', 'cancelled')";

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Families matching the query, one page, with the total before paging. */
export async function listFamilyAccounts(
  tx: TransactionSql,
  schoolId: string,
  query: FamilyListQuery,
): Promise<{ families: FinanceFamily[]; total: number }> {
  const rows = await familyPage(tx, schoolId, query, query.limit, query.offset);
  if (rows.length === 0) {
    // count(*) OVER () has no row to ride on past the last page; ask the first page for the total,
    // so a pager left on a page that no longer exists can still recover.
    const [first] = query.offset > 0 ? await familyPage(tx, schoolId, query, 1, 0) : [];
    return { families: [], total: first?.total ?? 0 };
  }
  return {
    families: await hydrateFamilies(
      tx,
      schoolId,
      rows.map((row) => row.id),
    ),
    total: rows[0]!.total,
  };
}

/** Ids of one page of families matching the query, each carrying the total match count. */
function familyPage(
  tx: TransactionSql,
  schoolId: string,
  query: FamilyListQuery,
  limit: number,
  offset: number,
): Promise<{ id: string; total: number }[]> {
  const term = query.search?.trim() ?? "";
  const pattern = likePattern(term);
  const searchFilter = term
    ? tx`AND (
        family.display_name ILIKE ${pattern}
        OR EXISTS (
          SELECT 1
          FROM app.parent_child_links AS link
          JOIN app.students AS student
            ON student.id = link.student_id AND student.school_id = link.school_id
          WHERE link.school_id = family.school_id AND link.family_id = family.id
            AND (student.first_name || ' ' || student.last_name ILIKE ${pattern}
              OR coalesce(student.preferred_name, '') || ' ' || student.last_name ILIKE ${pattern}
              OR student.admission_number ILIKE ${pattern})
        )
        OR EXISTS (
          SELECT 1
          FROM app.parent_child_links AS link
          JOIN app.users AS guardian
            ON guardian.id = link.parent_user_id AND guardian.school_id = link.school_id
          WHERE link.school_id = family.school_id AND link.family_id = family.id
            AND (coalesce(guardian.display_name, '') ILIKE ${pattern} OR guardian.email ILIKE ${pattern})
        )
      )`
    : tx``;
  const childFilter =
    query.min_children !== undefined
      ? tx`AND coalesce(kids.child_count, 0) >= ${query.min_children}`
      : tx``;
  const balanceFilter =
    query.balance === "overdue"
      ? tx`AND coalesce(money.overdue_major, 0) > 0`
      : query.balance === "outstanding"
        ? tx`AND coalesce(money.outstanding_major, 0) > 0`
        : tx``;
  // Sorting by "largest balance" compares major units across currencies. It orders the list; it
  // never adds two currencies into a figure anyone sees.
  const order =
    query.sort === "outstanding"
      ? tx`ORDER BY coalesce(money.outstanding_major, 0) DESC, family.display_name, family.id`
      : tx`ORDER BY family.display_name, family.id`;

  return tx<{ id: string; total: number }[]>`
    WITH members AS (
      SELECT DISTINCT family_id, student_id
      FROM app.parent_child_links
      WHERE school_id = ${schoolId}::uuid
    ),
    kids AS (
      SELECT family_id, count(*)::int AS child_count FROM members GROUP BY family_id
    ),
    money AS (
      SELECT members.family_id,
             sum(ic.outstanding_amount_minor::numeric / power(10, c.minor_unit)) AS outstanding_major,
             sum(ic.outstanding_amount_minor::numeric / power(10, c.minor_unit))
               FILTER (WHERE ic.due_date < CURRENT_DATE) AS overdue_major
      FROM members
      JOIN app.invoice_cache AS ic
        ON ic.student_id = members.student_id AND ic.school_id = ${schoolId}::uuid
      JOIN app.currencies AS c ON c.id = ic.currency_id
      WHERE ${tx.unsafe(LIVE_INVOICE)} AND ic.outstanding_amount_minor > 0
      GROUP BY members.family_id
    )
    SELECT family.id, count(*) OVER ()::int AS total
    FROM app.families AS family
    LEFT JOIN kids ON kids.family_id = family.id
    LEFT JOIN money ON money.family_id = family.id
    WHERE family.school_id = ${schoolId}::uuid
      ${searchFilter}
      ${childFilter}
      ${balanceFilter}
    ${order}
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/** Every family with at least one invoice past due and unpaid. */
export async function overdueFamilyIds(tx: TransactionSql, schoolId: string): Promise<string[]> {
  const rows = await tx<{ family_id: string }[]>`
    SELECT DISTINCT link.family_id
    FROM app.parent_child_links AS link
    JOIN app.invoice_cache AS ic
      ON ic.student_id = link.student_id AND ic.school_id = link.school_id
    WHERE link.school_id = ${schoolId}::uuid
      AND ${tx.unsafe(LIVE_INVOICE)}
      AND ic.outstanding_amount_minor > 0
      AND ic.due_date < CURRENT_DATE
    ORDER BY link.family_id
  `;
  return rows.map((row) => row.family_id);
}

/** One family, or null when it is not this school's. */
export async function getFamilyAccount(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
): Promise<(FinanceFamily & { communications: CommunicationRow[] }) | null> {
  const [family] = await hydrateFamilies(tx, schoolId, [familyId]);
  if (!family) return null;
  return {
    ...family,
    communications: await listFamilyCommunications(tx, schoolId, familyId, 50),
  };
}

/** Everything the list and profile show, for the given families, in the given order. */
async function hydrateFamilies(
  tx: TransactionSql,
  schoolId: string,
  familyIds: string[],
): Promise<FinanceFamily[]> {
  const [families, guardians, children, balances, lastPayments, lastReminders] = await Promise.all([
    tx<{ id: string; display_name: string }[]>`
      SELECT id, display_name
      FROM app.families
      WHERE school_id = ${schoolId}::uuid AND id = ANY(${familyIds}::uuid[])
    `,
    tx<{ family_id: string; user_id: string; name: string; email: string; is_primary: boolean }[]>`
      WITH members AS (
        SELECT id AS family_id, primary_parent_user_id AS user_id
        FROM app.families
        WHERE school_id = ${schoolId}::uuid AND id = ANY(${familyIds}::uuid[])
        UNION
        SELECT family_id, parent_user_id
        FROM app.parent_child_links
        WHERE school_id = ${schoolId}::uuid AND family_id = ANY(${familyIds}::uuid[])
      )
      SELECT members.family_id, guardian.id AS user_id,
             coalesce(guardian.display_name, guardian.email) AS name, guardian.email,
             guardian.id = family.primary_parent_user_id AS is_primary
      FROM members
      JOIN app.families AS family
        ON family.id = members.family_id AND family.school_id = ${schoolId}::uuid
      JOIN app.users AS guardian
        ON guardian.id = members.user_id AND guardian.school_id = family.school_id
      ORDER BY members.family_id, guardian.id
    `,
    tx<
      {
        family_id: string;
        student_id: string;
        name: string;
        admission_number: string;
        status: string;
      }[]
    >`
      SELECT DISTINCT ON (link.family_id, student.id)
             link.family_id, student.id AS student_id,
             coalesce(student.preferred_name, student.first_name) || ' ' || student.last_name AS name,
             student.admission_number, student.status::text AS status,
             student.date_of_birth
      FROM app.parent_child_links AS link
      JOIN app.students AS student
        ON student.id = link.student_id AND student.school_id = link.school_id
      WHERE link.school_id = ${schoolId}::uuid AND link.family_id = ANY(${familyIds}::uuid[])
      ORDER BY link.family_id, student.id
    `,
    tx<
      {
        family_id: string;
        currency: string;
        minor_unit: number;
        billed: string;
        outstanding: string;
        overdue: string;
        overdue_count: number;
      }[]
    >`
      WITH members AS (
        SELECT DISTINCT family_id, student_id
        FROM app.parent_child_links
        WHERE school_id = ${schoolId}::uuid AND family_id = ANY(${familyIds}::uuid[])
      )
      SELECT members.family_id, c.code AS currency, c.minor_unit,
             sum(ic.total_amount_minor)::text AS billed,
             sum(ic.outstanding_amount_minor)::text AS outstanding,
             coalesce(sum(ic.outstanding_amount_minor)
               FILTER (WHERE ic.due_date < CURRENT_DATE), 0)::text AS overdue,
             (count(*) FILTER (
               WHERE ic.due_date < CURRENT_DATE AND ic.outstanding_amount_minor > 0))::int
               AS overdue_count
      FROM members
      JOIN app.invoice_cache AS ic
        ON ic.student_id = members.student_id AND ic.school_id = ${schoolId}::uuid
      JOIN app.currencies AS c ON c.id = ic.currency_id
      WHERE ${tx.unsafe(LIVE_INVOICE)}
      GROUP BY members.family_id, c.code, c.minor_unit
      ORDER BY members.family_id, c.code
    `,
    tx<{ family_id: string; last_payment_date: string }[]>`
      SELECT link.family_id, max(pc.payment_date)::text AS last_payment_date
      FROM app.parent_child_links AS link
      JOIN app.payment_cache AS pc
        ON pc.student_id = link.student_id AND pc.school_id = link.school_id
      WHERE link.school_id = ${schoolId}::uuid
        AND link.family_id = ANY(${familyIds}::uuid[])
        AND pc.status <> 'failed'
      GROUP BY link.family_id
    `,
    tx<{ family_id: string; last_reminder_at: Date }[]>`
      SELECT family_id, max(created_at) AS last_reminder_at
      FROM app.finance_communications
      WHERE school_id = ${schoolId}::uuid
        AND family_id = ANY(${familyIds}::uuid[])
        AND kind = 'payment_reminder'
      GROUP BY family_id
    `,
  ]);

  const studentIds = [...new Set(children.map((child) => child.student_id))];
  const [rule, standings] = await Promise.all([
    loadSiblingDiscountRule(tx, schoolId),
    studentIds.length > 0
      ? loadSiblingStandings(tx, schoolId, studentIds)
      : Promise.resolve(new Map()),
  ]);

  const byId = new Map(families.map((family) => [family.id, family]));
  const paymentByFamily = new Map(lastPayments.map((row) => [row.family_id, row]));
  const reminderByFamily = new Map(lastReminders.map((row) => [row.family_id, row]));

  return familyIds.flatMap((familyId): FinanceFamily[] => {
    const family = byId.get(familyId);
    if (!family) return [];

    const familyChildren = children
      .filter((child) => child.family_id === familyId)
      .map((child) => {
        const standing = standings.get(child.student_id);
        const percentage = siblingPercentageFor(rule, standing);
        return {
          student_id: child.student_id,
          name: child.name,
          admission_number: child.admission_number,
          status: child.status,
          child_position: standing?.child_position ?? null,
          sibling_discount_percentage: percentage === null ? null : Number(percentage),
        };
      })
      // Eldest first, the order the sibling rule ranks them in; children not enrolled go last.
      .sort(
        (a, b) =>
          (a.child_position ?? Number.MAX_SAFE_INTEGER) -
            (b.child_position ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name),
      );

    const familyBalances = balances.filter((row) => row.family_id === familyId);
    const lastReminder = reminderByFamily.get(familyId)?.last_reminder_at ?? null;

    return [
      {
        id: family.id,
        display_name: family.display_name,
        guardians: guardians
          .filter((guardian) => guardian.family_id === familyId)
          .map(({ family_id: _family, ...guardian }) => guardian)
          .sort(
            (a, b) => Number(b.is_primary) - Number(a.is_primary) || a.name.localeCompare(b.name),
          ),
        children: familyChildren,
        balances: familyBalances.map((row) => {
          const billed = BigInt(row.billed);
          const outstanding = BigInt(row.outstanding);
          const overdue = BigInt(row.overdue);
          return {
            currency: row.currency,
            currency_minor_unit: row.minor_unit,
            billed: formatMinorUnits(billed, row.minor_unit),
            billed_minor: Number(billed),
            outstanding: formatMinorUnits(outstanding, row.minor_unit),
            outstanding_minor: Number(outstanding),
            overdue: formatMinorUnits(overdue, row.minor_unit),
            overdue_minor: Number(overdue),
          };
        }),
        overdue_invoice_count: familyBalances.reduce((sum, row) => sum + row.overdue_count, 0),
        last_payment_date: paymentByFamily.get(familyId)?.last_payment_date ?? null,
        last_reminder_at: lastReminder ? lastReminder.toISOString() : null,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// One payment, split across the family's invoices
// ---------------------------------------------------------------------------

export interface PlannedAllocation {
  invoice_id: string;
  student_id: string;
  amount_minor: bigint;
}

interface OpenInvoice {
  invoice_id: string;
  student_id: string;
  outstanding_minor: bigint;
}

/**
 * Split `amountMinor` across `invoices`, which must already be in paying order (oldest due first).
 * Pure, so the rule a finance clerk sees previewed in the form is the rule the server applies.
 * Throws when the family owes less than the amount.
 */
export function allocateOldestFirst(
  amountMinor: bigint,
  invoices: readonly OpenInvoice[],
): PlannedAllocation[] {
  const owed = invoices.reduce((sum, invoice) => sum + invoice.outstanding_minor, 0n);
  if (amountMinor > owed) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.FAMILY_PAYMENT_EXCEEDS_BALANCE,
      "The amount is more than the family owes in this currency",
    );
  }
  const plan: PlannedAllocation[] = [];
  let remaining = amountMinor;
  for (const invoice of invoices) {
    if (remaining <= 0n) break;
    const share = remaining < invoice.outstanding_minor ? remaining : invoice.outstanding_minor;
    if (share <= 0n) continue;
    plan.push({
      invoice_id: invoice.invoice_id,
      student_id: invoice.student_id,
      amount_minor: share,
    });
    remaining -= share;
  }
  return plan;
}

/** Check a split finance chose by hand against what each invoice owes. */
export function validateAllocations(
  amountMinor: bigint,
  requested: readonly { invoice_id: string; amount_minor: bigint }[],
  invoices: readonly OpenInvoice[],
): PlannedAllocation[] {
  const open = new Map(invoices.map((invoice) => [invoice.invoice_id, invoice]));
  const seen = new Set<string>();
  let sum = 0n;
  const plan: PlannedAllocation[] = [];
  for (const allocation of requested) {
    const invoice = open.get(allocation.invoice_id);
    const fail = (message: string): never => {
      throw new CodedHttpException(400, ERROR_CODES.FAMILY_PAYMENT_ALLOCATION_INVALID, message);
    };
    if (!invoice) fail(`${allocation.invoice_id} is not an open invoice of this family`);
    if (seen.has(allocation.invoice_id)) fail(`${allocation.invoice_id} appears more than once`);
    if (allocation.amount_minor <= 0n) fail(`${allocation.invoice_id} has no amount`);
    if (allocation.amount_minor > invoice!.outstanding_minor) {
      fail(`${allocation.invoice_id} owes less than the amount allocated to it`);
    }
    seen.add(allocation.invoice_id);
    sum += allocation.amount_minor;
    plan.push({
      invoice_id: allocation.invoice_id,
      student_id: invoice!.student_id,
      amount_minor: allocation.amount_minor,
    });
  }
  if (sum !== amountMinor) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.FAMILY_PAYMENT_ALLOCATION_INVALID,
      "The allocations do not add up to the amount paid",
    );
  }
  return plan;
}

/** The family's invoices in `currencyId` that still owe money, oldest due first. */
async function openInvoices(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  currencyId: string,
): Promise<OpenInvoice[]> {
  const rows = await tx<{ invoice_id: string; student_id: string; outstanding_minor: string }[]>`
    SELECT ic.erpnext_docname AS invoice_id, ic.student_id,
           ic.outstanding_amount_minor::text AS outstanding_minor
    FROM app.invoice_cache AS ic
    WHERE ic.school_id = ${schoolId}::uuid
      AND ic.currency_id = ${currencyId}::uuid
      AND ${tx.unsafe(LIVE_INVOICE)}
      AND ic.outstanding_amount_minor > 0
      AND ic.student_id IN (
        SELECT link.student_id FROM app.parent_child_links AS link
        WHERE link.school_id = ${schoolId}::uuid AND link.family_id = ${familyId}::uuid
      )
    ORDER BY ic.due_date ASC NULLS LAST, ic.issued_date ASC, ic.erpnext_docname
  `;
  return rows.map((row) => ({ ...row, outstanding_minor: BigInt(row.outstanding_minor) }));
}

/** The per-invoice key a family payment's share is posted under. Stable for a given key + invoice. */
export function allocationIdempotencyKey(familyKey: string, invoiceId: string): string {
  const digest = createHash("sha256").update(`${familyKey}\u0000${invoiceId}`).digest("hex");
  return `family-payment:${digest.slice(0, 48)}`;
}

export interface FamilyPaymentResult {
  invoice_id: string;
  student_id: string;
  amount: string;
  status: "recorded" | "replayed" | "failed";
  payment: PaymentRow | null;
  error: string | null;
}

/**
 * Record one family payment as one ERPNext Payment Entry per invoice it pays.
 *
 * Each share goes through the single-invoice forwarder (`createPayment`) under a key derived from
 * the family key and the invoice, so it inherits that path's exactly-once guarantee: a retry of the
 * whole request replays the shares already posted and retries only the ones that failed. Shares are
 * posted one after another, not in parallel, so a failing ERPNext is not hit with the whole batch.
 */
export async function recordFamilyPayment(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  context: Required<Pick<TenantContext, "schoolId" | "userId">> & { requestId?: string },
  familyId: string,
  body: CreateFamilyPaymentBody,
  familyKey: string,
  acceptLanguage?: string,
): Promise<{
  outcome: "completed" | "partial" | "failed";
  currency: string;
  results: FamilyPaymentResult[];
}> {
  const schoolId = context.schoolId;
  const { currency, plan } = await withStudentIdentityTx(database, schoolId, async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      SELECT id FROM app.families WHERE school_id = ${schoolId}::uuid AND id = ${familyId}::uuid
    `;
    if (!family) {
      throw new CodedHttpException(404, ERROR_CODES.FAMILY_NOT_FOUND, "Family not found");
    }
    const currencyRef = await getCurrencyByCode(tx, body.currency);
    if (!currencyRef) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Unknown or inactive currency: ${body.currency}`,
      );
    }
    const invoices = await openInvoices(tx, schoolId, familyId, currencyRef.id);
    const amountMinor = toMinorUnits(body.amount, currencyRef.minorUnit);
    const planned = body.allocations
      ? validateAllocations(
          amountMinor,
          body.allocations.map((allocation) => ({
            invoice_id: allocation.invoice_id,
            amount_minor: toMinorUnits(allocation.amount, currencyRef.minorUnit),
          })),
          invoices,
        )
      : allocateOldestFirst(amountMinor, invoices);
    return { currency: currencyRef, plan: planned };
  });

  const results: FamilyPaymentResult[] = [];
  for (const share of plan) {
    const amount = formatMinorUnits(share.amount_minor, currency.minorUnit);
    try {
      const { row, replayed } = await createPayment(
        database,
        erpnextFactory,
        context,
        {
          student_id: share.student_id,
          invoice_id: share.invoice_id,
          amount: Number(amount),
          payment_mode: body.payment_mode,
          currency: currency.code,
          ...(body.reference_no !== undefined && { reference_no: body.reference_no }),
          ...(body.reference_date !== undefined && { reference_date: body.reference_date }),
          ...(body.posting_date !== undefined && { posting_date: body.posting_date }),
          ...(body.remarks !== undefined && { remarks: body.remarks }),
        },
        allocationIdempotencyKey(familyKey, share.invoice_id),
        acceptLanguage,
      );
      results.push({
        invoice_id: share.invoice_id,
        student_id: share.student_id,
        amount,
        status: replayed ? "replayed" : "recorded",
        payment: row,
        error: null,
      });
    } catch (error) {
      results.push({
        invoice_id: share.invoice_id,
        student_id: share.student_id,
        amount,
        status: "failed",
        payment: null,
        error: error instanceof Error ? error.message : "The payment could not be recorded",
      });
    }
  }

  const failed = results.filter((result) => result.status === "failed").length;
  const outcome = failed === 0 ? "completed" : failed === results.length ? "failed" : "partial";
  return { outcome, currency: currency.code, results };
}
