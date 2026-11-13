import { NOTIFICATION_TYPES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { NOTIFICATION_CATALOG } from "../registry";
import { AR_TEMPLATES } from "../templates/ar";
import { EN_TEMPLATES } from "../templates/en";
import { renderNotification } from "../templates/renderer";
import { NOTIFICATION_CHANNELS } from "../types";

import type { NotificationChannel } from "../types";

const ALL_CHANNELS: NotificationChannel[] = [
  NOTIFICATION_CHANNELS.IN_APP,
  NOTIFICATION_CHANNELS.PUSH,
  NOTIFICATION_CHANNELS.EMAIL,
];

const ALL_TYPES = Object.values(NOTIFICATION_TYPES);

describe("notification catalog", () => {
  test("every NOTIFICATION_TYPE has a catalog entry", () => {
    for (const type of ALL_TYPES) {
      expect(NOTIFICATION_CATALOG).toHaveProperty(type);
    }
  });

  test("every catalog entry has all three channels", () => {
    for (const type of ALL_TYPES) {
      const entry = NOTIFICATION_CATALOG[type];
      for (const channel of ALL_CHANNELS) {
        expect(entry.channels).toContain(channel);
      }
    }
  });
});

describe("templates — completeness", () => {
  const locales = [
    { name: "en", templates: EN_TEMPLATES },
    { name: "ar", templates: AR_TEMPLATES },
  ] as const;

  for (const { name, templates } of locales) {
    describe(name, () => {
      for (const type of ALL_TYPES) {
        describe(type, () => {
          for (const channel of ALL_CHANNELS) {
            test(`${channel} template is non-empty`, () => {
              const tmpl = templates[type][channel];
              expect(tmpl).toBeTruthy();
              expect(tmpl.trim().length).toBeGreaterThan(0);
            });

            test(`${channel} template contains only known variables`, () => {
              const tmpl = templates[type][channel];
              const placeholders = tmpl.match(/\{(\w+)\}/g) ?? [];
              for (const ph of placeholders) {
                const varName = ph.slice(1, -1);
                expect(
                  Object.keys(NOTIFICATION_CATALOG[type].metadataDefaults).includes(varName) ||
                    [
                      "courseName",
                      "assignmentName",
                      "dueDate",
                      "grade",
                      "discussionTitle",
                      "replierName",
                      "groupName",
                      "inviterName",
                      "subject",
                      "date",
                      "title",
                      "summary",
                      "fileName",
                      "virus",
                      "pages",
                      "senderName",
                      "preview",
                      "studentName",
                      "amount",
                      "receiptNumber",
                      "familyName",
                      "overdueCount",
                      "outstanding",
                      "childCount",
                      "schoolName",
                      "periodEnd",
                      "endsAt",
                      "daysLeft",
                      "invoiceNumber",
                      "balance",
                    ].includes(varName),
                ).toBe(true);
              }
            });
          }
        });
      }
    });
  }
});

describe("renderNotification — snapshot tests", () => {
  const sampleVars = {
    [NOTIFICATION_TYPES.ASSIGNMENT_DUE_SOON]: {
      courseName: "Algebra II",
      assignmentName: "Homework 5",
      dueDate: "2026-08-15",
    },
    [NOTIFICATION_TYPES.GRADE_POSTED]: {
      courseName: "Biology 101",
      assignmentName: "Lab Report 3",
      grade: "A-",
    },
    [NOTIFICATION_TYPES.ENROLLMENT_APPROVED]: {
      courseName: "World History",
    },
    [NOTIFICATION_TYPES.COURSE_PUBLISHED]: {
      courseName: "Introduction to Python",
    },
    [NOTIFICATION_TYPES.DISCUSSION_REPLY]: {
      courseName: "English Literature",
      discussionTitle: "Week 4: Shakespeare",
      replierName: "Jane Smith",
    },
    [NOTIFICATION_TYPES.STUDY_GROUP_INVITE]: {
      groupName: "Calculus Study Group",
      inviterName: "John Doe",
    },
    [NOTIFICATION_TYPES.CERTIFICATE_ISSUED]: {
      courseName: "Data Structures",
    },
    [NOTIFICATION_TYPES.SUPPORT_MESSAGE]: {
      subject: "Issue with login",
    },
    [NOTIFICATION_TYPES.ATTENDANCE_ALERT]: {
      courseName: "Physics",
      date: "2026-07-28",
    },
    [NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT]: {
      title: "Campus closed Friday",
      summary: "The campus will be closed for maintenance on Friday. Classes resume Monday.",
    },
    [NOTIFICATION_TYPES.ANNOUNCEMENT]: {
      title: "New library hours starting Monday",
      summary: "The library will now open at 7am on weekdays through the end of term.",
    },
    [NOTIFICATION_TYPES.MATERIAL_SCAN_QUARANTINED]: {
      fileName: "eicar-test.txt",
      virus: "Win.Test.EICAR_HDB-1",
    },
    [NOTIFICATION_TYPES.MATERIAL_SCAN_FAILED]: {
      fileName: "notes.pdf",
    },
    [NOTIFICATION_TYPES.MATERIAL_OCR_LOW_CONFIDENCE]: {
      fileName: "scanned-guide.pdf",
      pages: "2, 4",
    },
    [NOTIFICATION_TYPES.MATERIAL_INGESTED]: {
      fileName: "lecture-notes.pdf",
    },
    [NOTIFICATION_TYPES.MATERIAL_INGEST_FAILED]: {
      fileName: "lab-manual.pdf",
    },
    [NOTIFICATION_TYPES.DIRECT_MESSAGE]: {
      senderName: "Layla Nasser",
      preview: "Adam did really well on today's lab.",
    },
    [NOTIFICATION_TYPES.FEE_INVOICE_ISSUED]: {
      studentName: "Adam Fares",
      amount: "600.000 JOD",
      dueDate: "2026-09-01",
    },
    [NOTIFICATION_TYPES.FEE_PAYMENT_RECEIVED]: {
      studentName: "Adam Fares",
      amount: "300.000 JOD",
      receiptNumber: "ACC-PAY-2026-00004",
    },
    [NOTIFICATION_TYPES.FEE_PAYMENT_REMINDER]: {
      familyName: "Bassel Fares Family",
      amount: "1950.000 JOD",
      overdueCount: "2",
    },
    [NOTIFICATION_TYPES.FEE_STATEMENT]: {
      familyName: "Bassel Fares Family",
      outstanding: "1950.000 JOD",
      childCount: "2",
    },
    [NOTIFICATION_TYPES.LICENSE_SEAT_APPLE_RENEWAL]: {
      schoolName: "Amman Academy",
      periodEnd: "2026-11-30",
    },
    [NOTIFICATION_TYPES.LICENSE_EXPIRING]: {
      schoolName: "Amman Academy",
      endsAt: "2027-08-31",
      daysLeft: "30",
    },
    [NOTIFICATION_TYPES.LICENSE_INVOICE_DUE]: {
      schoolName: "Amman Academy",
      invoiceNumber: "LIC-2026-000042",
      balance: "4374.00 USD",
      dueDate: "2026-11-30",
    },
    [NOTIFICATION_TYPES.LICENSE_INVOICE_OVERDUE]: {
      schoolName: "Amman Academy",
      invoiceNumber: "LIC-2026-000042",
      balance: "2187.00 USD",
      dueDate: "2026-11-30",
    },
    [NOTIFICATION_TYPES.LICENSE_RECEIPT_UPLOADED]: {
      schoolName: "Amman Academy",
      invoiceNumber: "LIC-2026-000042",
    },
  } as const;

  const locales = ["en", "ar"] as const;

  for (const locale of locales) {
    describe(locale, () => {
      for (const type of ALL_TYPES) {
        for (const channel of ALL_CHANNELS) {
          test(`${type} / ${channel} renders correctly`, () => {
            const result = renderNotification(
              type,
              channel,
              locale,
              sampleVars[type] as Record<string, string>,
            );
            expect(result).toMatchSnapshot();
          });
        }
      }
    });
  }
});
