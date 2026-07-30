import { AR_TEMPLATES } from "./ar";
import { EN_TEMPLATES } from "./en";

import type { NotificationChannel } from "../types";
import type { NotificationType } from "@studafy/constants";

const LOCALE_MAP = { en: EN_TEMPLATES, ar: AR_TEMPLATES };

export function renderNotification(
  type: NotificationType,
  channel: NotificationChannel,
  locale: "en" | "ar",
  vars: Record<string, string>,
): string {
  const localeSet = LOCALE_MAP[locale];
  const template = localeSet[type][channel];
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key in vars) {
      return String(vars[key]);
    }
    return `{${key}}`;
  });
}
