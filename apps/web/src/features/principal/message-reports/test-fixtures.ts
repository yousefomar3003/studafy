import type { MessageReport, MessageReportDetail } from "./queries";

/** Shared report fixtures for the message-report screen tests. */

export function reportFixture(overrides: Partial<MessageReport> = {}): MessageReport {
  return {
    id: "report-1",
    status: "pending",
    priority: "urgent",
    respond_by: "2026-10-12T10:00:00.000Z",
    is_overdue: true,
    reason_category: "harassment",
    details: "He keeps messaging late at night &amp; it&#39;s upsetting.",
    conversation_id: "conversation-1",
    message_id: "message-2",
    reporter: { id: "parent-1", name: "Layla Hassan", role: "parent" },
    reported: { id: "teacher-1", name: "Omar Saleh", role: "teacher" },
    student: { id: "student-1", name: "Sami Hassan" },
    block_exists: true,
    resolution_note: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: "2026-10-11T10:00:00.000Z",
    updated_at: "2026-10-11T10:00:00.000Z",
    ...overrides,
  };
}

export function reportDetailFixture(
  overrides: Partial<MessageReportDetail> = {},
): MessageReportDetail {
  return {
    ...reportFixture(),
    messages: [
      {
        id: "message-1",
        sender_id: "parent-1",
        sender_name: "Layla Hassan",
        body: "Is the homework due tomorrow?",
        created_at: "2026-10-10T18:00:00.000Z",
        is_reported: false,
        attachments: [],
      },
      {
        id: "message-2",
        sender_id: "teacher-1",
        sender_name: "Omar Saleh",
        body: "Stop asking &lt;b&gt;me&lt;/b&gt; questions",
        created_at: "2026-10-10T23:30:00.000Z",
        is_reported: true,
        attachments: [
          {
            id: "attachment-1",
            content_type: "image/png",
            size_bytes: 2048,
            download_url: "https://storage.example.test/attachment-1.png?sig=abc",
            download_url_expires_at: "2026-10-11T10:05:00.000Z",
          },
          {
            id: "attachment-2",
            content_type: "image/jpeg",
            size_bytes: 4096,
            download_url: null,
            download_url_expires_at: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}
