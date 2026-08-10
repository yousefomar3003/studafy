import { NOTIFICATION_TYPES } from "@studafy/constants";

import { NOTIFICATION_CHANNELS } from "../types";

import type { LocaleTemplateSet } from "./types";

export const EN_TEMPLATES = {
  [NOTIFICATION_TYPES.ASSIGNMENT_DUE_SOON]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{assignmentName} is due {dueDate}",
    [NOTIFICATION_CHANNELS.PUSH]: "{courseName} — {assignmentName} due {dueDate}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "Your assignment {assignmentName} in {courseName} is due on {dueDate}. Submit before the deadline.",
  },
  [NOTIFICATION_TYPES.GRADE_POSTED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "Grade posted for {assignmentName}: {grade}",
    [NOTIFICATION_CHANNELS.PUSH]: "Grade: {grade} on {assignmentName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "Your grade for {assignmentName} in {courseName} has been posted: {grade}.",
  },
  [NOTIFICATION_TYPES.ENROLLMENT_APPROVED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "You have been enrolled in {courseName}",
    [NOTIFICATION_CHANNELS.PUSH]: "Enrolled in {courseName}",
    [NOTIFICATION_CHANNELS.EMAIL]: "Your enrollment in {courseName} has been approved.",
  },
  [NOTIFICATION_TYPES.COURSE_PUBLISHED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{courseName} is now available",
    [NOTIFICATION_CHANNELS.PUSH]: "New course: {courseName}",
    [NOTIFICATION_CHANNELS.EMAIL]: "A new course is now available: {courseName}.",
  },
  [NOTIFICATION_TYPES.DISCUSSION_REPLY]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "New reply from {replierName} in {discussionTitle}",
    [NOTIFICATION_CHANNELS.PUSH]: "{replierName} replied to {discussionTitle}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      '{replierName} has replied to "{discussionTitle}" in {courseName}.',
  },
  [NOTIFICATION_TYPES.STUDY_GROUP_INVITE]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{inviterName} invited you to {groupName}",
    [NOTIFICATION_CHANNELS.PUSH]: "Study group invite: {groupName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      '{inviterName} has invited you to join the study group "{groupName}".',
  },
  [NOTIFICATION_TYPES.CERTIFICATE_ISSUED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "Certificate issued for {courseName}",
    [NOTIFICATION_CHANNELS.PUSH]: "Certificate: {courseName}",
    [NOTIFICATION_CHANNELS.EMAIL]: "Your certificate for {courseName} is now available.",
  },
  [NOTIFICATION_TYPES.SUPPORT_MESSAGE]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{subject}",
    [NOTIFICATION_CHANNELS.PUSH]: "New message: {subject}",
    [NOTIFICATION_CHANNELS.EMAIL]: "You have a new support message regarding: {subject}.",
  },
  [NOTIFICATION_TYPES.ATTENDANCE_ALERT]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "Attendance alert for {courseName} on {date}",
    [NOTIFICATION_CHANNELS.PUSH]: "Alert: {courseName} — {date}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "This is an attendance alert for {courseName}. Absences were recorded on {date}.",
  },
  [NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{title}",
    [NOTIFICATION_CHANNELS.PUSH]: "Announcement: {title}",
    [NOTIFICATION_CHANNELS.EMAIL]: "{title}\n\n{summary}",
  },
  [NOTIFICATION_TYPES.MATERIAL_SCAN_QUARANTINED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{fileName} was blocked by a malware scan",
    [NOTIFICATION_CHANNELS.PUSH]: "Upload blocked: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      'Your file "{fileName}" was blocked because it is infected with {virus}. It will not be served.',
  },
  [NOTIFICATION_TYPES.MATERIAL_SCAN_FAILED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{fileName} could not be scanned",
    [NOTIFICATION_CHANNELS.PUSH]: "Upload not scanned: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      'Your file "{fileName}" could not be scanned and was not made available. Please upload it again.',
  },
  [NOTIFICATION_TYPES.MATERIAL_OCR_LOW_CONFIDENCE]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{fileName} needs a quick review",
    [NOTIFICATION_CHANNELS.PUSH]: "Review needed: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      'Your file "{fileName}" was transcribed automatically, but these pages were hard to read: {pages}. Please check them.',
  },
  [NOTIFICATION_TYPES.MATERIAL_INGESTED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{fileName} is ready for AI search",
    [NOTIFICATION_CHANNELS.PUSH]: "Ready for search: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      'Your file "{fileName}" has finished processing and is now searchable.',
  },
  [NOTIFICATION_TYPES.MATERIAL_INGEST_FAILED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "{fileName} could not be made searchable",
    [NOTIFICATION_CHANNELS.PUSH]: "Processing failed: {fileName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      'Your file "{fileName}" could not be processed and is not searchable. You can try again from the material page.',
  },
} as const satisfies LocaleTemplateSet;
