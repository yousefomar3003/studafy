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
  [NOTIFICATION_TYPES.ANNOUNCEMENT]: {
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
  [NOTIFICATION_TYPES.DIRECT_MESSAGE]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "New message from {senderName}",
    [NOTIFICATION_CHANNELS.PUSH]: "{senderName}: {preview}",
    [NOTIFICATION_CHANNELS.EMAIL]: '{senderName} sent you a message: "{preview}"',
  },
  [NOTIFICATION_TYPES.FEE_INVOICE_ISSUED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "New invoice for {studentName}: {amount}",
    [NOTIFICATION_CHANNELS.PUSH]: "Invoice for {studentName}: {amount}, due {dueDate}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "A new invoice of {amount} has been issued for {studentName}. It is due on {dueDate}.",
  },
  [NOTIFICATION_TYPES.FEE_PAYMENT_RECEIVED]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "Payment received for {studentName}: {amount}",
    [NOTIFICATION_CHANNELS.PUSH]: "Thank you — we received {amount} for {studentName}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "We received your payment of {amount} for {studentName}. Receipt number: {receiptNumber}.",
  },
  [NOTIFICATION_TYPES.FEE_PAYMENT_REMINDER]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "Reminder: {amount} in school fees is overdue",
    [NOTIFICATION_CHANNELS.PUSH]: "School fees reminder: {amount} overdue",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "Dear {familyName}, this is a reminder that {amount} in school fees is overdue across {overdueCount} invoice(s). Please contact the school's finance office if you have already paid.",
  },
  [NOTIFICATION_TYPES.FEE_STATEMENT]: {
    [NOTIFICATION_CHANNELS.IN_APP]: "Your family fee statement: {outstanding} outstanding",
    [NOTIFICATION_CHANNELS.PUSH]: "Fee statement: {outstanding} outstanding",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "Dear {familyName}, here is your fee statement for {childCount} child(ren). The outstanding balance is {outstanding}. Open the Studafy app for the full detail.",
  },
  [NOTIFICATION_TYPES.LICENSE_SEAT_APPLE_RENEWAL]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "{schoolName} now covers your Studafy subscription. To avoid paying twice, turn off its renewal on your iPhone: Settings > your name > Subscriptions > Studafy > Cancel Subscription. You keep access until {periodEnd}, and the school's seat continues after that.",
    [NOTIFICATION_CHANNELS.PUSH]:
      "{schoolName} now covers Studafy: turn off your App Store renewal",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "{schoolName} has given you a Studafy seat that covers your App Store subscription. Apple does not let us stop its renewal for you, so to avoid paying twice please turn it off: on your iPhone open Settings, tap your name, then Subscriptions, Studafy, Cancel Subscription. You keep access until {periodEnd}, and the school's seat continues after that.",
  },
  [NOTIFICATION_TYPES.LICENSE_EXPIRING]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "{schoolName}'s Studafy license ends on {endsAt}, in {daysLeft} days. Renew it to keep its seats covered.",
    [NOTIFICATION_CHANNELS.PUSH]: "{schoolName}: the Studafy license ends in {daysLeft} days",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "{schoolName}'s Studafy license ends on {endsAt}, in {daysLeft} days. When it ends, everyone holding one of its seats loses the features it covers. Contact Studafy to renew or extend it.",
  },
  [NOTIFICATION_TYPES.LICENSE_INVOICE_DUE]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "Invoice {invoiceNumber} for {schoolName}'s Studafy license is due today ({dueDate}). Balance: {balance}.",
    [NOTIFICATION_CHANNELS.PUSH]: "Studafy invoice {invoiceNumber} is due today: {balance}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "Invoice {invoiceNumber} for {schoolName}'s Studafy license is due today, {dueDate}, with {balance} outstanding. Please pay by bank transfer with the payment reference printed on the invoice, and upload the receipt in Studafy.",
  },
  [NOTIFICATION_TYPES.LICENSE_INVOICE_OVERDUE]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "Invoice {invoiceNumber} for {schoolName}'s Studafy license is overdue (due {dueDate}). Balance: {balance}.",
    [NOTIFICATION_CHANNELS.PUSH]: "Studafy invoice {invoiceNumber} is overdue: {balance}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "Invoice {invoiceNumber} for {schoolName}'s Studafy license was due on {dueDate} and {balance} is still outstanding. Please pay by bank transfer with the payment reference printed on the invoice, and upload the receipt in Studafy.",
  },
  [NOTIFICATION_TYPES.LICENSE_RECEIPT_UPLOADED]: {
    [NOTIFICATION_CHANNELS.IN_APP]:
      "{schoolName} uploaded a transfer receipt for invoice {invoiceNumber}. Match it to a payment.",
    [NOTIFICATION_CHANNELS.PUSH]: "{schoolName} uploaded a receipt for {invoiceNumber}",
    [NOTIFICATION_CHANNELS.EMAIL]:
      "{schoolName} uploaded a bank transfer receipt for invoice {invoiceNumber}. Record the payment and match the receipt to it in the license console.",
  },
} as const satisfies LocaleTemplateSet;
