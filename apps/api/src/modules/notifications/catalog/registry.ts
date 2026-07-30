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
} as const satisfies NotificationCatalog;
