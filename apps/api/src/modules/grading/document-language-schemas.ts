import { z } from "@hono/zod-openapi";

/**
 * Document language settings (000263). The enums are spelled inline on each field, not shared as
 * a referenced component: the Dart client generator cannot compile a described or defaulted
 * referenced enum (docs/plans/academic-phase2.md, "The mobile rule").
 */

const LANGUAGES = ["viewer", "en", "ar", "bilingual"] as const;

const LANGUAGE_HELP =
  "viewer: each reader's own language (as before); en: English; ar: Arabic, right to left; bilingual: English and Arabic side by side.";

export const documentLanguageSettingsSchema = z
  .object({
    report_card_language: z.enum(LANGUAGES).openapi({
      description: `Term report cards. ${LANGUAGE_HELP}`,
    }),
    certificate_language: z.enum(LANGUAGES).openapi({
      description: `Annual certificates. ${LANGUAGE_HELP}`,
    }),
    transcript_language: z.enum(LANGUAGES).openapi({
      description: `Academic transcripts. ${LANGUAGE_HELP}`,
    }),
    school_name_ar: z.string().nullable().openapi({
      description: "The school's Arabic name shown on documents; null uses its name.",
    }),
  })
  .openapi("DocumentLanguageSettings");

export const updateDocumentLanguageSettingsBodySchema = z
  .object({
    report_card_language: z.enum(LANGUAGES).optional(),
    certificate_language: z.enum(LANGUAGES).optional(),
    transcript_language: z.enum(LANGUAGES).optional(),
    school_name_ar: z.string().trim().max(200).nullable().optional().openapi({
      description: "Omitted: unchanged. null or blank: cleared.",
    }),
  })
  .strict()
  .openapi("UpdateDocumentLanguageSettingsBody");
