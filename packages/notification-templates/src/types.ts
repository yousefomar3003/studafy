import type { NotificationType } from "@studafy/constants";

export const NOTIFICATION_CHANNELS = {
  IN_APP: "in_app",
  PUSH: "push",
  EMAIL: "email",
} as const;

export type NotificationChannel =
  (typeof NOTIFICATION_CHANNELS)[keyof typeof NOTIFICATION_CHANNELS];

export interface CatalogEntry {
  channels: NotificationChannel[];
  metadataDefaults: Record<string, string>;
}

export type NotificationCatalog = Record<NotificationType, CatalogEntry>;

export interface NotificationTypeVars {
  ASSIGNMENT_DUE_SOON: {
    courseName: string;
    assignmentName: string;
    dueDate: string;
  };
  GRADE_POSTED: {
    courseName: string;
    assignmentName: string;
    grade: string;
  };
  ENROLLMENT_APPROVED: {
    courseName: string;
  };
  COURSE_PUBLISHED: {
    courseName: string;
  };
  DISCUSSION_REPLY: {
    courseName: string;
    discussionTitle: string;
    replierName: string;
  };
  STUDY_GROUP_INVITE: {
    groupName: string;
    inviterName: string;
  };
  CERTIFICATE_ISSUED: {
    courseName: string;
  };
  SUPPORT_MESSAGE: {
    subject: string;
  };
  ATTENDANCE_ALERT: {
    courseName: string;
    date: string;
  };
  ADMIN_ANNOUNCEMENT: {
    title: string;
    summary: string;
  };
  ANNOUNCEMENT: {
    title: string;
    summary: string;
  };
  MATERIAL_SCAN_QUARANTINED: {
    fileName: string;
    virus: string;
  };
  MATERIAL_SCAN_FAILED: {
    fileName: string;
  };
  MATERIAL_OCR_LOW_CONFIDENCE: {
    fileName: string;
    pages: string;
  };
  // Ingestion outcomes (000096). Raised by the ai-ingestion worker directly into
  // app.notifications when a material finishes ingestion or its retries were exhausted.
  MATERIAL_INGESTED: {
    fileName: string;
  };
  MATERIAL_INGEST_FAILED: {
    fileName: string;
  };
  // Parent<->teacher messaging (000126). Written by apps/api/src/modules/messaging directly into
  // app.notifications for the other participant of a thread.
  DIRECT_MESSAGE: {
    senderName: string;
    preview: string;
  };
  // Fee notices to guardians (000152). Written by apps/api/src/modules/finance/communications.
  // Amounts arrive already formatted with their currency ("600.000 JOD").
  FEE_INVOICE_ISSUED: {
    studentName: string;
    amount: string;
    dueDate: string;
  };
  FEE_PAYMENT_RECEIVED: {
    studentName: string;
    amount: string;
    receiptNumber: string;
  };
  FEE_PAYMENT_REMINDER: {
    familyName: string;
    amount: string;
    overdueCount: string;
  };
  FEE_STATEMENT: {
    familyName: string;
    outstanding: string;
    childCount: string;
  };
  LICENSE_SEAT_APPLE_RENEWAL: {
    schoolName: string;
    periodEnd: string;
  };
  LICENSE_EXPIRING: {
    schoolName: string;
    endsAt: string;
    daysLeft: string;
  };
  LICENSE_INVOICE_DUE: {
    schoolName: string;
    invoiceNumber: string;
    balance: string;
    dueDate: string;
  };
  LICENSE_INVOICE_OVERDUE: {
    schoolName: string;
    invoiceNumber: string;
    balance: string;
    dueDate: string;
  };
  LICENSE_RECEIPT_UPLOADED: {
    schoolName: string;
    invoiceNumber: string;
  };
}
