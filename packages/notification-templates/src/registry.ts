import { NOTIFICATION_TYPES } from "@studafy/constants";

import { NOTIFICATION_CHANNELS } from "./types";

import type { NotificationCatalog } from "./types";

export const NOTIFICATION_CATALOG = {
  [NOTIFICATION_TYPES.ASSIGNMENT_DUE_SOON]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/courses/{courseId}/assignments/{assignmentId}",
    },
  },
  [NOTIFICATION_TYPES.GRADE_POSTED]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/courses/{courseId}/grades",
    },
  },
  [NOTIFICATION_TYPES.ENROLLMENT_APPROVED]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/courses/{courseId}",
    },
  },
  [NOTIFICATION_TYPES.COURSE_PUBLISHED]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/courses/{courseId}",
    },
  },
  [NOTIFICATION_TYPES.DISCUSSION_REPLY]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/courses/{courseId}/discussions/{discussionId}",
    },
  },
  [NOTIFICATION_TYPES.STUDY_GROUP_INVITE]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/groups/{groupId}",
    },
  },
  [NOTIFICATION_TYPES.CERTIFICATE_ISSUED]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/certificates/{certificateId}",
    },
  },
  [NOTIFICATION_TYPES.SUPPORT_MESSAGE]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/support/tickets/{ticketId}",
    },
  },
  [NOTIFICATION_TYPES.ATTENDANCE_ALERT]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/courses/{courseId}/attendance",
    },
  },
  [NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/announcements",
    },
  },
  [NOTIFICATION_TYPES.ANNOUNCEMENT]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "/announcements",
    },
  },
  // File-scan outcomes (000088). Raised by the workers' file-scan queue directly into
  // app.notifications — no dispatch event today — so the catalog entries exist to keep
  // NotificationCatalog total and the route is empty; nothing routes to a quarantined file.
  [NOTIFICATION_TYPES.MATERIAL_SCAN_QUARANTINED]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "",
    },
  },
  [NOTIFICATION_TYPES.MATERIAL_SCAN_FAILED]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "",
    },
  },
  // OCR quality (000090). Raised by the ai-ingestion worker directly into app.notifications when an
  // OCR'd material has low-confidence pages — no dispatch event today, so the entry exists to keep
  // NotificationCatalog total and the route is empty; nothing links to a flagged page yet.
  [NOTIFICATION_TYPES.MATERIAL_OCR_LOW_CONFIDENCE]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "",
    },
  },
  // Ingestion outcomes (000096). Raised by the ai-ingestion worker directly into
  // app.notifications — no dispatch event today, so the entries exist to keep NotificationCatalog
  // total and the routes are empty; nothing deep-links to a material detail page yet.
  [NOTIFICATION_TYPES.MATERIAL_INGESTED]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "",
    },
  },
  [NOTIFICATION_TYPES.MATERIAL_INGEST_FAILED]: {
    channels: [
      NOTIFICATION_CHANNELS.IN_APP,
      NOTIFICATION_CHANNELS.PUSH,
      NOTIFICATION_CHANNELS.EMAIL,
    ],
    metadataDefaults: {
      route: "",
    },
  },
} as const satisfies NotificationCatalog;
