/**
 * Arabic content moderation: patterns and student-facing guidance for the same categories as
 * `policy.ts`, which only knew English. Most Studafy students write in Arabic, so without these an
 * Arabic self-harm message, threat or slur reached the model, and an Arabic student who was blocked
 * read the reason in English.
 *
 * Matching runs on {@link normalizeArabic} text: diacritics and tatweel removed, the alef, yaa,
 * taa-marbuta and hamza-seat variants folded, and letters stretched for emphasis ("كسسس") collapsed,
 * so the patterns below are written once, in that folded spelling (أ→ا, ى→ي, ة→ه, ؤ→و, ئ→ي).
 *
 * As in English, the patterns stay narrow on purpose so a study question is not blocked: "قتل" alone
 * (history, biology) passes, a threat to kill someone does not; "الجنس" alone (biology) passes,
 * explicit material does not. Arabic glues prefixes (و ف ب ل ك ال) and pronoun suffixes to a word,
 * so {@link arabicWords} allows those around each term while still refusing a match inside a longer
 * word.
 */

import type { AgeLevel } from "./policy";

/** Arabic letters folded to one spelling, so a pattern needs to list each word only once. */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ٰٟـ]/g, "") // harakat, superscript alef, tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/(\p{Script=Arabic})\1{2,}/gu, "$1");
}

/** Whether a text is mostly Arabic words (the language to give guidance in). */
export function isMostlyArabic(text: string): boolean {
  const arabic = text.match(/\p{Script=Arabic}+/gu)?.length ?? 0;
  const latin = text.match(/[A-Za-z]+/g)?.length ?? 0;
  return arabic > 0 && arabic >= latin;
}

const PREFIX = "(?:[وف])?(?:بال|كال|لل|ال|ب|ل|ك)?";
const SUFFIX = "(?:ه|ها|هم|هن|ك|كم|كن|ي|نا|ات|ين|ون|ان|يه|يا)?";

/**
 * One regex for a list of Arabic words or phrases: each may carry the usual attached prefixes and
 * pronoun suffixes, but must not sit inside a longer word (no Arabic or Latin letter right before
 * the prefix or right after the suffix).
 */
function arabicWords(terms: readonly string[], options: { affixes?: boolean } = {}): RegExp {
  const affixes = options.affixes ?? true;
  const body = terms.map((t) => t.replace(/ /g, "\\s+")).join("|");
  // eslint-disable-next-line security/detect-non-literal-regexp -- built once from this module's own constants, never from input
  return new RegExp(
    `(?<![\\p{L}])${affixes ? PREFIX : ""}(?:${body})${affixes ? SUFFIX : ""}(?![\\p{L}])`,
    "u",
  );
}

// Child safety: a minor term and an explicit term in the same sentence, in either order.
const MINOR = String.raw`(?:طفل|اطفال|طفله|طفلات|قاصر|قاصرات|قاصرين|صغيره|صغار|بنت صغيره|ولد صغير|بنات صغار|عمرها \d{1,2}|عمره \d{1,2})`;
const EXPLICIT = String.raw`(?:عاري|عاريه|عراه|عري|اباحي|اباحيه|بورن|سكس|نودز|جنسيه صريحه|صور جنسيه|فيديو جنسي|افلام جنسيه)`;
const SAME_SENTENCE = String.raw`[^.!?؟\n]{0,60}`;
const NOT_LETTER_BEFORE = String.raw`(?<![\p{L}])`;

/** Arabic patterns per category key (the keys of `MODERATION_CATEGORIES`). */
export const ARABIC_PATTERNS: Readonly<Record<string, readonly RegExp[]>> = {
  csam: [
    // eslint-disable-next-line security/detect-non-literal-regexp -- built once from this module's own constants, never from input
    new RegExp(
      `${NOT_LETTER_BEFORE}${PREFIX}${MINOR}${SAME_SENTENCE}${EXPLICIT}`.replace(/ /g, "\\s+"),
      "u",
    ),
    // eslint-disable-next-line security/detect-non-literal-regexp -- built once from this module's own constants, never from input
    new RegExp(
      `${NOT_LETTER_BEFORE}${PREFIX}${EXPLICIT}${SAME_SENTENCE}${MINOR}`.replace(/ /g, "\\s+"),
      "u",
    ),
    arabicWords(["استغلال جنسي للاطفال", "اباحيه الاطفال", "بورن اطفال", "سكس اطفال"]),
  ],
  self_harm: [
    arabicWords(["انتحر", "انتحار", "انتحاري", "سانتحر", "رح انتحر", "راح انتحر", "بنتحر"]),
    arabicWords([
      "اقتل نفسي",
      "انهي حياتي",
      "انهي نفسي",
      "اوذي نفسي",
      "اذي نفسي",
      "اجرح نفسي",
      "اقطع شراييني",
      "اقطع عروقي",
    ]),
    arabicWords(
      [
        "(?:اريد|اريد ان|ابغي|ابغا|ابي|بدي|بدي اياني|حابب|حابه|نفسي|ودي|اتمني|اتمني ان) (?:ان )?اموت",
        "مش بدي اعيش",
        "ما بدي اعيش",
        "ما ابغي اعيش",
        "لا اريد ان اعيش",
        "كيف (?:انتحر|اموت|اقتل نفسي)",
        "طريقه (?:للانتحار|الانتحار)",
      ],
      { affixes: false },
    ),
  ],
  hate_speech: [
    arabicWords(["زنجي", "زنوج", "زنجيه"], { affixes: false }),
    arabicWords(["ارجع لبلدك", "ارجع على بلدك", "ارجعوا لبلادكم", "ارجعوا لبلدكم"], {
      affixes: false,
    }),
  ],
  sexual_content: [
    arabicWords(["اباحي", "اباحيه", "بورن", "سكس", "نودز", "الاستمناء", "العاده السريه"]),
    arabicWords(
      [
        "(?:صور|صوره|فيديو|فيديوهات|مقاطع|افلام) (?:عاري|عاريه|عاريات|اباحيه|سكس|جنسيه)",
        "(?:ارسل|ارسلي|ابعث|ابعثي|ابعتلي|ابعتي|ارسللي|ابعثلي|ابعتيلي) (?:لي )?(?:صوره|صور)(?:ك)? (?:عاري|عاريه|بدون ملابس)",
        "محادثه جنسيه",
        "شات سكس",
      ],
      { affixes: false },
    ),
  ],
  violence: [
    arabicWords(
      [
        "(?:رح|راح|سوف|بدي|ابغي|ابي|ناوي) (?:اقتل|اذبح|اطخ|اطعن|افجر|احرق)(?:ك|ه|ها|هم|كم)?",
        "(?:ساقتل|ساذبح|سافجر|حقتل|حاقتل)(?:ك|ه|ها|هم|كم)",
        "(?:اقتلك|اقتلكم|اذبحك|اذبحكم)",
        "(?:اقتل|اذبح|اطعن|اطخ) (?:المعلم|المعلمه|الاستاذ|الاستاذه|المدرس|المدرسه|المدير|المديره|الطلاب|زميلي|زميلتي|صاحبي|اخوي|اختي)",
        "كيف (?:اصنع|اعمل|اسوي|اجهز|احضر) (?:قنبله|متفجرات|عبوه ناسفه|حزام ناسف|سلاح)",
        "طريقه (?:صنع|عمل) (?:قنبله|متفجرات|عبوه ناسفه)",
      ],
      { affixes: false },
    ),
  ],
  profanity: [
    arabicWords([
      "شرموط",
      "شرموطه",
      "شراميط",
      "منيوك",
      "منيوكه",
      "قحبه",
      "قحاب",
      "متناك",
      "معرص",
      "عرص",
    ]),
    arabicWords(
      [
        "كس امك",
        "كس اختك",
        "كسمك",
        "كسختك",
        "كس",
        "زب",
        "زبي",
        "طيز",
        "طيزك",
        "نيك",
        "انيك",
        "ينيك",
        "يلعن (?:ابوك|امك|دينك|شرفك|اختك)",
        "ابن (?:الكلب|كلب|الشرموطه|القحبه|الحرام)",
        "يا (?:حمار|كلب|حيوان|حقير|زباله|واطي)",
        "خرا",
        "خراء",
      ],
      { affixes: false },
    ),
    // Arabizi: the same insults typed in Latin letters and digits.
    /\b(?:kos\s*om+(?:ak|k)?|kosomak|kos\s*o5tak|sharmo?o?ta|manyo+k|ibn\s*el\s*(?:kalb|sharmoota)|ya\s*(?:7mar|hmar|kalb)|ayre?\s*feek|zeb+i)\b/i,
  ],
  pii_sharing: [],
};

/** Arabic guidance per category and age level, shown when an Arabic message is blocked. */
export const ARABIC_GUIDANCE: Readonly<Record<string, Record<AgeLevel, string>>> = {
  csam: {
    elementary:
      "لا نستطيع المساعدة في هذا. إذا جعلك أحد تشعر بعدم الأمان، أخبر شخصًا بالغًا تثق به أو المرشد في مدرستك فورًا.",
    middle:
      "هذا المحتوى غير مسموح. إذا طلب منك أحد صورًا أو جعلك تشعر بعدم الأمان، أخبر شخصًا بالغًا تثق به أو المرشد في مدرستك.",
    high: "هذا المحتوى غير مسموح وتم الإبلاغ عنه للمراجعة. إذا كان أحد يضغط عليك أو يجعلك تشعر بعدم الأمان، تحدّث مع شخص بالغ تثق به أو مع المرشد في مدرستك.",
  },
  self_harm: {
    elementary:
      "إذا كنت حزينًا أو متألمًا، تحدّث مع شخص بالغ تثق به أو مع المرشد في مدرستك. أنت لست وحدك.",
    middle:
      "إذا كنت تمرّ بوقت صعب، تواصل مع شخص بالغ تثق به أو مع المرشد في مدرستك. المساعدة متاحة لك.",
    high: "إذا كانت لديك أفكار بإيذاء نفسك، تواصل مع شخص بالغ تثق به أو مع مرشد. لست مضطرًا لمواجهة هذا وحدك.",
  },
  hate_speech: {
    elementary: "لنحافظ على الاحترام في حديثنا. كل شخص يستحق أن يُعامَل بلطف.",
    middle: "هذه الكلمات جارحة وغير مسموح بها. أعد صياغة سؤالك باحترام.",
    high: "خطاب الكراهية غير مقبول. حافظ على احترام الآخرين في كلامك.",
  },
  sexual_content: {
    elementary: "هذا المحتوى غير مناسب لمكان التعلّم. لنركّز على دروسك.",
    middle: "هذا المحتوى غير مناسب هنا. اجعل أسئلتك عن التعلّم.",
    high: "هذا المحتوى غير مناسب لمكان التعلّم. عُد إلى دراستك.",
  },
  violence: {
    elementary: "التهديد والحديث عن العنف غير مقبول أبدًا. لنتعلّم في مكان آمن.",
    middle: "نتعامل مع التهديد بالعنف بجدية. أعد صياغة سؤالك بطريقة مناسبة.",
    high: "التهديد بالعنف غير مقبول وقد يتم الإبلاغ عنه. أعد صياغة سؤالك.",
  },
  profanity: {
    elementary: "استخدم كلمات مناسبة للمدرسة في أسئلتك.",
    middle: "استخدم كلمات مناسبة للمدرسة.",
    high: "استخدم كلمات لائقة في أسئلتك.",
  },
  pii_sharing: {
    elementary: "لا تشارك معلوماتك الخاصة مثل رقم هاتفك أو عنوانك. حافظ على أمانك على الإنترنت!",
    middle: "لا تشارك معلوماتك الخاصة مثل رقم الهاتف أو العنوان أو البريد الإلكتروني.",
    high: "لا تشارك معلوماتك الشخصية في أسئلتك، حفاظًا على أمانك.",
  },
};
