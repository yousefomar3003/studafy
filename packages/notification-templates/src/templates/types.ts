import type { NotificationChannel, NotificationTypeVars } from "../types";

export type IcuTemplate = string;

export type ChannelTemplates = Record<NotificationChannel, IcuTemplate>;

export type LocaleTemplateSet = {
  [K in keyof NotificationTypeVars]: ChannelTemplates;
};
