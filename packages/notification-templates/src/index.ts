/**
 * The notification catalog and its localized templates.
 *
 * Lifted out of apps/api by ST-139. The notification dispatcher runs in apps/workers, which has no
 * dependency edge to apps/api, and the alternative — a second copy of nine notification types times
 * three channels times two locales — would have drifted the first time either side was edited.
 *
 * apps/api re-exports this package from src/modules/notifications/index.ts, so nothing that
 * imported the catalog from there had to change.
 */
export { NOTIFICATION_CATALOG } from "./registry";
export { NOTIFICATION_CHANNELS } from "./types";
export type { NotificationChannel, NotificationCatalog, NotificationTypeVars } from "./types";
export { renderNotification, TEMPLATE_LOCALES, isTemplateLocale } from "./templates/renderer";
export type { TemplateLocale } from "./templates/renderer";
export { AR_TEMPLATES } from "./templates/ar";
export { EN_TEMPLATES } from "./templates/en";
export type { IcuTemplate, ChannelTemplates, LocaleTemplateSet } from "./templates/types";
