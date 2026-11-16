import type { NotificationChannel, NotificationTypeVars } from "../types";

export type IcuTemplate = string;

export type ChannelTemplates = Record<NotificationChannel, IcuTemplate>;

/**
 * Types that are never emailed: their catalog entry lists no email channel, so their template set
 * has no email entry to keep translated. Notifications are not emailed, so every new type belongs
 * here.
 */
export type UnemailedNotificationType = "MATERIAL_PUBLISHED";

export type InAppAndPushTemplates = Omit<ChannelTemplates, "email">;

export type LocaleTemplateSet = {
  [K in keyof NotificationTypeVars]: K extends UnemailedNotificationType
    ? InAppAndPushTemplates
    : ChannelTemplates;
};
