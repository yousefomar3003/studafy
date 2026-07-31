/**
 * Worker-side notification rendering (ST-139).
 *
 * A thin seam over @studafy/notification-templates: resolve which locale this recipient should be
 * addressed in, build the variables the GRADE_POSTED template expects, and produce the title and
 * body a dispatch writes.
 *
 * The templates themselves are not duplicated here. They moved out of apps/api into a shared
 * package precisely so this file could be thin — nine notification types across three channels and
 * two locales, kept in one place, is the only version of this that stays correct.
 */

import {
  NOTIFICATION_CATALOG,
  NOTIFICATION_CHANNELS,
  isTemplateLocale,
  renderNotification,
} from "@studafy/notification-templates";

import type { NotificationType } from "@studafy/constants";
import type { NotificationChannel, TemplateLocale } from "@studafy/notification-templates";

/** The locale used when neither the recipient nor their school has expressed a renderable one. */
export const FALLBACK_LOCALE: TemplateLocale = "en";

export interface RenderedNotification {
  title: string;
  body: string;
}

/**
 * The recipient's locale, falling back through the school's and then to English.
 *
 * Both inputs are wider than what templates exist for. `app.user_notification_settings.locale` and
 * `app.school_settings.locale` are constrained only to a BCP-47 shape, and the settings API accepts
 * six locales while there are templates for two. So each candidate is narrowed rather than trusted:
 * a school set to `fr` falls through to English instead of indexing a template map with `fr` and
 * throwing at render time, one notification at a time, in production only.
 */
export function resolveLocale(
  recipientLocale: string | null | undefined,
  schoolLocale: string | null | undefined,
): TemplateLocale {
  if (isTemplateLocale(recipientLocale)) return recipientLocale;
  if (isTemplateLocale(schoolLocale)) return schoolLocale;
  return FALLBACK_LOCALE;
}

/**
 * Render one notification.
 *
 * The title comes from the in_app template and the body from the channel's own, which is what the
 * catalog's shape supports: templates are one string per channel, and app.notifications needs two.
 * Using in_app for the title keeps a push and an email about the same event carrying the same
 * headline, and in_app is the shortest of the three, which is the right property for a title.
 */
export function render(
  type: NotificationType,
  channel: NotificationChannel,
  locale: TemplateLocale,
  vars: Record<string, string>,
): RenderedNotification {
  return {
    title: renderNotification(type, NOTIFICATION_CHANNELS.IN_APP, locale, vars),
    body: renderNotification(type, channel, locale, vars),
  };
}

/**
 * The deep-link route for a notification type, with its `{placeholder}` ids substituted.
 *
 * Unresolved placeholders are left intact rather than blanked, matching renderNotification: a route
 * that still reads `/courses/{courseId}/grades` is visibly broken in a log, whereas `/courses//grades`
 * looks plausible and 404s in a client.
 */
export function resolveRoute(type: NotificationType, ids: Record<string, string>): string {
  const route = NOTIFICATION_CATALOG[type].metadataDefaults.route ?? "";
  return route.replace(/\{(\w+)\}/g, (match, key: string) => ids[key] ?? match);
}
