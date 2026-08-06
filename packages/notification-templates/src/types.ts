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
}
