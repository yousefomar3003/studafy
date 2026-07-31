/**
 * The notification catalog now lives in @studafy/notification-templates (ST-139), so apps/workers
 * can render the same strings apps/api does. This barrel is kept as the API-side entry point, so no
 * call site inside apps/api had to change when the catalog moved.
 */
export {
  NOTIFICATION_CATALOG,
  NOTIFICATION_CHANNELS,
  renderNotification,
  TEMPLATE_LOCALES,
  isTemplateLocale,
} from "@studafy/notification-templates";
export type {
  NotificationChannel,
  NotificationCatalog,
  NotificationTypeVars,
  TemplateLocale,
  IcuTemplate,
  ChannelTemplates,
  LocaleTemplateSet,
} from "@studafy/notification-templates";
