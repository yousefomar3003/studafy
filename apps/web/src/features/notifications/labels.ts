import { NOTIFICATION_TYPES } from "@studafy/constants";
import { NOTIFICATION_CHANNELS } from "@studafy/notification-templates";

import { i18next } from "../../lib/i18n/i18next";

import type { NotificationType } from "@studafy/constants";
import type { NotificationChannel } from "@studafy/notification-templates";

type Translate = (key: string) => string;

/** Reads the shared i18next instance at call time — for callers without a hook `t` in scope. */
const defaultTranslate: Translate = (key) => i18next.t(key);

// Sets (not plain objects), same reasoning `billing/labels.ts`'s STATUS_LABEL_KEY gives: a wire
// string can never resolve a prototype member. Labels live in `site.notifications.types.<TYPE>` /
// `site.notifications.channels.<channel>` and are translated when rendered.

const KNOWN_TYPES = new Set<string>(Object.values(NOTIFICATION_TYPES) satisfies NotificationType[]);

/** Falls back to the raw wire value for a type the catalog hasn't been kept in lockstep with yet,
 * rather than rendering nothing. */
export function notificationTypeLabel(type: string, t: Translate = defaultTranslate): string {
  return KNOWN_TYPES.has(type) ? t(`site.notifications.types.${type}`) : type;
}

const KNOWN_CHANNELS = new Set<string>(
  Object.values(NOTIFICATION_CHANNELS) satisfies NotificationChannel[],
);

export function notificationChannelLabel(channel: string, t: Translate = defaultTranslate): string {
  return KNOWN_CHANNELS.has(channel) ? t(`site.notifications.channels.${channel}`) : channel;
}
