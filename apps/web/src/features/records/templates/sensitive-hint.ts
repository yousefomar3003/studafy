/**
 * The template editor's "this looks sensitive" hint while a label is typed. The same patterns as
 * `labelSuggestsSensitive` in packages/records (which the API echoes as `label_suggests_sensitive`
 * on saved fields), restated here so the web bundle does not pull in the records package and its
 * crypto. A hint only: the school decides.
 */
const SENSITIVE_LABEL_HINTS: readonly RegExp[] = [
  /\b(national|civil|personal|government|state)\s*(id|identity|identification|number|no\.?)\b/i,
  /\bid\s*(number|no\.?|card)\b/i,
  /\b(passport|iqama|residen(ce|cy)\s*(permit|number)|visa|ssn|social\s*security|tax\s*(id|number))\b/i,
  /\b(medical|medication|medicine|diagnos\w*|health|disabilit\w*|condition|illness|mental|therapy|prescription|blood\s*type)\b/i,
  /(هوية|الهوية|رقم\s*مدني|الرقم\s*المدني|البطاقة\s*المدنية|جواز|الجواز|إقامة|الإقامة|تأشيرة|طبي|طبية|صحي|صحية|دواء|أدوية|تشخيص|إعاقة|مرض|فصيلة\s*الدم)/,
];

export function labelSuggestsSensitive(...labels: string[]): boolean {
  return labels.some((label) => SENSITIVE_LABEL_HINTS.some((pattern) => pattern.test(label)));
}
