import { api } from "../../../lib/api";

import type { Invoice } from "../invoices/queries";
import type { components } from "@studafy/api-client";

export type FinanceStudentIdentity = components["schemas"]["FinanceStudentIdentity"];
export type Installment = components["schemas"]["Installment"];

export function financeStudentQueryKey(studentId: string) {
  return ["finance", "students", studentId] as const;
}

export async function fetchFinanceStudent(studentId: string): Promise<FinanceStudentIdentity> {
  const { data } = await api.GET("/api/finance/students/{studentId}", {
    params: { path: { studentId } },
  });
  if (!data) throw new Error("Student not found.");
  return data as FinanceStudentIdentity;
}

/** A student's invoices, newest first: one page of 100 covers years of billing for one child. */
export async function fetchStudentInvoices(studentId: string): Promise<Invoice[]> {
  const { data } = await api.GET("/api/finance/invoices", {
    params: { query: { student_id: studentId, limit: 100 } },
  });
  return (data?.invoices ?? []) as Invoice[];
}

export async function fetchStudentInstallments(studentId: string): Promise<Installment[]> {
  const { data } = await api.GET("/api/finance/students/{studentId}/installments", {
    params: { path: { studentId }, query: { limit: 100, offset: 0 } },
  });
  return (data?.installments ?? []) as Installment[];
}
