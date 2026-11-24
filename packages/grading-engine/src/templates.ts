import { DEFAULT_DIPLOMA_CONFIG, DEFAULT_DIPLOMA_MAX } from "./diploma";

import type { DiplomaConfig } from "./diploma";
import type {
  CategoryAggregation,
  CategoryKind,
  GradeBand,
  GradingMethod,
  ResultFormat,
  RoundingRule,
} from "./types";

/**
 * Curriculum templates: ready-made grading set-ups a school applies to an academic year's grades
 * instead of building scales, result formats and assessment categories by hand.
 *
 * A template is plain data. Applying one (apps/api curriculum-template-service) creates or updates
 * the school's own scale, grade programs and subject configurations through the ordinary
 * configuration services, so everything it sets is an editable default: boundaries, weights and
 * pass marks belong to the school from then on. Nothing here is read when grades are computed.
 *
 * Boundaries are sensible defaults, not awarding-body boundaries (those change every exam
 * series). Exam-board templates (IGCSE, A-Level, BTEC, IB DP, Irish) pass a subject at 40%.
 */

export type TemplateLocale = "en" | "ar";

export interface LocalizedText {
  en: string;
  ar: string;
}

export type CurriculumTemplateId =
  | "national_percentage"
  | "igcse_9_1"
  | "igcse_a_star_g"
  | "a_level"
  | "btec"
  | "british_key_stages"
  | "ib_pyp"
  | "ib_myp"
  | "ib_dp"
  | "american"
  | "french"
  | "irish_junior_cycle"
  | "irish_leaving_certificate";

export type CurriculumFamily = "national" | "british" | "ib" | "american" | "french" | "irish";

export interface TemplateBand {
  label: LocalizedText;
  /** Inclusive lower bound, as for {@link GradeBand}. */
  minPercentage: number;
  gpaPoints: number | null;
}

export interface TemplateDescriptor {
  label: LocalizedText;
  points: number | null;
  notAchieved: boolean;
}

/** One term category; every term gets one assessment of it, out of `maxMarks`. */
export interface TemplateCategory {
  /** Stable reference, unique within the template. */
  key: string;
  name: LocalizedText;
  kind: CategoryKind;
  /** Share of the term grade (weighted method); null for total-points and descriptive subjects. */
  weight: number | null;
  aggregation: CategoryAggregation;
  maxMarks: number;
}

/**
 * Where a subject's term structure comes from: the school's own exam system (School Settings,
 * the same structure new subjects start from today) or the template's own categories.
 */
export type TemplateStructure =
  { source: "exam_structure" } | { source: "categories"; categories: readonly TemplateCategory[] };

export interface TemplateCourseLevel {
  label: LocalizedText;
  /** Weighted GPA boost a subject at this level carries. */
  gpaBoost: number;
}

export interface TemplateSubjectDefaults {
  method: GradingMethod;
  /** The scale a subject's marks are reported on (100, 20, 32...). */
  maxMarks: number;
  passPercentage: number;
  rounding: RoundingRule;
  structure: TemplateStructure;
  /**
   * When present, every subject gets these credits and coefficient (an American school weights by
   * credit hours, so both are equal). Absent: a subject keeps its own.
   */
  credits?: { credits: number; averageWeight: number };
}

export interface CurriculumTemplate {
  id: CurriculumTemplateId;
  family: CurriculumFamily;
  name: LocalizedText;
  description: LocalizedText;
  /** The grade's scale (also each subject's, by inheritance); null for descriptor templates. */
  scale: { name: LocalizedText; bands: readonly TemplateBand[] } | null;
  /** The grade's descriptor scale, highest first; only for descriptive templates. */
  descriptors: readonly TemplateDescriptor[] | null;
  resultFormat: ResultFormat;
  /** Rounding of the grade's overall average. */
  overallRounding: RoundingRule;
  subject: TemplateSubjectDefaults;
  /** Course levels a subject can be set to afterwards (shown as guidance; not applied). */
  courseLevels: readonly TemplateCourseLevel[];
  /**
   * A `points_total` template's diploma rules (TOK x EE matrix and award conditions), applied to
   * the grade as editable defaults. Absent for every other result format.
   */
  diploma?: DiplomaConfig;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const same = (text: string): LocalizedText => ({ en: text, ar: text });
const text = (en: string, ar: string): LocalizedText => ({ en, ar });

const HALF_UP_2: RoundingRule = { decimals: 2, mode: "half_up" };
const PERCENTAGE: ResultFormat = { format: "percentage", max: 100 };

/** Bands from `[label, minPercentage, gpaPoints]`, labels the same in every language. */
function bands(rows: readonly (readonly [string, number, number | null])[]): TemplateBand[] {
  return rows.map(([label, minPercentage, gpaPoints]) => ({
    label: same(label),
    minPercentage,
    gpaPoints,
  }));
}

const category = (
  key: string,
  name: LocalizedText,
  kind: CategoryKind,
  weight: number,
): TemplateCategory => ({
  key,
  name,
  kind,
  weight,
  aggregation: "weighted_average",
  // A part worth 30% of the term is marked out of 30, as the school's exam system does.
  maxMarks: weight,
});

const HOMEWORK = text("Homework", "الواجبات");
const CLASSWORK = text("Classwork", "الأعمال الصفية");
const TESTS = text("Tests", "الاختبارات");
const END_OF_TERM_EXAM = text("End-of-term exam", "اختبار نهاية الفصل");

/** IGCSE and A-Level: coursework through the term and an end-of-term exam. */
const BRITISH_SECONDARY: TemplateStructure = {
  source: "categories",
  categories: [
    category("homework", HOMEWORK, "homework", 10),
    category("classwork", CLASSWORK, "classwork", 15),
    category("tests", TESTS, "exam", 25),
    category("end_of_term_exam", END_OF_TERM_EXAM, "final_exam", 50),
  ],
};

/** Descriptor subjects: one attainment judgement per term, refined by the school into skills. */
const ATTAINMENT: TemplateStructure = {
  source: "categories",
  categories: [
    {
      key: "attainment",
      name: text("Attainment", "التحصيل"),
      kind: "other",
      weight: null,
      aggregation: "weighted_average",
      maxMarks: 1,
    },
  ],
};

const numericSubject = (
  passPercentage: number,
  structure: TemplateStructure,
  overrides: Partial<TemplateSubjectDefaults> = {},
): TemplateSubjectDefaults => ({
  method: "weighted",
  maxMarks: 100,
  passPercentage,
  rounding: HALF_UP_2,
  structure,
  ...overrides,
});

const descriptiveSubject: TemplateSubjectDefaults = {
  method: "descriptive",
  maxMarks: 100,
  passPercentage: 50,
  rounding: HALF_UP_2,
  structure: ATTAINMENT,
};

/** IB MYP: a 0-32 criteria total's grade boundaries, as the lowest total of each grade 1-7. */
export const MYP_TOTAL_BOUNDARIES: readonly (readonly [grade: number, minTotal: number])[] = [
  [7, 28],
  [6, 24],
  [5, 19],
  [4, 15],
  [3, 10],
  [2, 6],
  [1, 0],
];
const MYP_MAX_TOTAL = 32;
const MYP_CRITERION_MAX = 8;

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

export const CURRICULUM_TEMPLATES: readonly CurriculumTemplate[] = [
  {
    id: "national_percentage",
    family: "national",
    name: text("National percentage", "النسبة المئوية (المنهاج الوطني)"),
    description: text(
      "Marks out of 100 with a 50% pass, as in Jordan and Egypt. Subjects follow the school's exam system from School Settings.",
      "علامات من 100 والنجاح من 50%، كما في الأردن ومصر. تتبع المواد نظام الاختبارات المحدد في إعدادات المدرسة.",
    ),
    scale: {
      name: text("National percentage", "النسبة المئوية"),
      bands: [
        { label: text("Excellent", "ممتاز"), minPercentage: 90, gpaPoints: null },
        { label: text("Very good", "جيد جدًا"), minPercentage: 80, gpaPoints: null },
        { label: text("Good", "جيد"), minPercentage: 70, gpaPoints: null },
        { label: text("Satisfactory", "متوسط"), minPercentage: 60, gpaPoints: null },
        { label: text("Pass", "مقبول"), minPercentage: 50, gpaPoints: null },
        { label: text("Fail", "راسب"), minPercentage: 0, gpaPoints: null },
      ],
    },
    descriptors: null,
    resultFormat: PERCENTAGE,
    overallRounding: HALF_UP_2,
    subject: numericSubject(50, { source: "exam_structure" }),
    courseLevels: [],
  },
  {
    id: "igcse_9_1",
    family: "british",
    name: text("IGCSE (9–1)", "IGCSE (من 9 إلى 1)"),
    description: text(
      "Grades 9 (highest) to 1, U ungraded. A subject passes at grade 4, the standard pass.",
      "الدرجات من 9 (الأعلى) إلى 1، وU غير مصنف. تنجح المادة عند الدرجة 4 (النجاح القياسي).",
    ),
    scale: {
      name: same("IGCSE 9–1"),
      bands: bands([
        ["9", 90, null],
        ["8", 80, null],
        ["7", 70, null],
        ["6", 60, null],
        ["5", 50, null],
        ["4", 40, null],
        ["3", 30, null],
        ["2", 20, null],
        ["1", 10, null],
        ["U", 0, null],
      ]),
    },
    descriptors: null,
    resultFormat: PERCENTAGE,
    overallRounding: HALF_UP_2,
    subject: numericSubject(40, BRITISH_SECONDARY),
    courseLevels: [
      { label: text("Core", "أساسي"), gpaBoost: 0 },
      { label: text("Extended", "موسّع"), gpaBoost: 0 },
    ],
  },
  {
    id: "igcse_a_star_g",
    family: "british",
    name: text("IGCSE (A*–G)", "IGCSE (من A* إلى G)"),
    description: text(
      "Grades A* to G, U ungraded. A subject passes from 40%.",
      "الدرجات من A* إلى G، وU غير مصنف. تنجح المادة من 40%.",
    ),
    scale: {
      name: same("IGCSE A*–G"),
      bands: bands([
        ["A*", 90, null],
        ["A", 80, null],
        ["B", 70, null],
        ["C", 60, null],
        ["D", 50, null],
        ["E", 40, null],
        ["F", 30, null],
        ["G", 20, null],
        ["U", 0, null],
      ]),
    },
    descriptors: null,
    resultFormat: PERCENTAGE,
    overallRounding: HALF_UP_2,
    subject: numericSubject(40, BRITISH_SECONDARY),
    courseLevels: [
      { label: text("Core", "أساسي"), gpaBoost: 0 },
      { label: text("Extended", "موسّع"), gpaBoost: 0 },
    ],
  },
  {
    id: "a_level",
    family: "british",
    name: text("A-Level (A*–E)", "المستوى المتقدم A-Level (من A* إلى E)"),
    description: text(
      "Grades A* to E, U ungraded. A subject passes at E (40%).",
      "الدرجات من A* إلى E، وU غير مصنف. تنجح المادة عند E (40%).",
    ),
    scale: {
      name: same("A-Level A*–E"),
      bands: bands([
        ["A*", 90, null],
        ["A", 80, null],
        ["B", 70, null],
        ["C", 60, null],
        ["D", 50, null],
        ["E", 40, null],
        ["U", 0, null],
      ]),
    },
    descriptors: null,
    resultFormat: PERCENTAGE,
    overallRounding: HALF_UP_2,
    subject: numericSubject(40, BRITISH_SECONDARY),
    courseLevels: [
      { label: same("AS"), gpaBoost: 0 },
      { label: same("A2"), gpaBoost: 0 },
    ],
  },
  {
    id: "btec",
    family: "british",
    name: text("BTEC", "BTEC"),
    description: text(
      "Pass, Merit, Distinction and Distinction*, graded on assignments and practical work.",
      "نجاح، جدارة، امتياز، وامتياز مع مرتبة الشرف، على أساس المهام والأعمال التطبيقية.",
    ),
    scale: {
      name: same("BTEC"),
      bands: [
        { label: text("Distinction*", "امتياز*"), minPercentage: 90, gpaPoints: null },
        { label: text("Distinction", "امتياز"), minPercentage: 75, gpaPoints: null },
        { label: text("Merit", "جدارة"), minPercentage: 60, gpaPoints: null },
        { label: text("Pass", "نجاح"), minPercentage: 40, gpaPoints: null },
        { label: text("Unclassified", "غير مصنف"), minPercentage: 0, gpaPoints: null },
      ],
    },
    descriptors: null,
    resultFormat: PERCENTAGE,
    overallRounding: HALF_UP_2,
    subject: numericSubject(40, {
      source: "categories",
      categories: [
        category("assignments", text("Assignments", "المهام"), "project", 70),
        category("practical", text("Practical work", "الأعمال التطبيقية"), "practical", 30),
      ],
    }),
    courseLevels: [],
  },
  {
    id: "british_key_stages",
    family: "british",
    name: text("British Key Stages", "المراحل الأساسية البريطانية"),
    description: text(
      "Primary attainment by descriptor: Working towards, Expected standard, Greater depth.",
      "تقييم المرحلة الابتدائية بالوصف: في طريقه إلى المستوى المتوقع، المستوى المتوقع، مستوى متعمق.",
    ),
    scale: null,
    descriptors: [
      { label: text("Greater depth", "مستوى متعمق"), points: 3, notAchieved: false },
      { label: text("Expected standard", "المستوى المتوقع"), points: 2, notAchieved: false },
      {
        label: text("Working towards", "في طريقه إلى المستوى المتوقع"),
        points: 1,
        notAchieved: false,
      },
    ],
    resultFormat: PERCENTAGE,
    overallRounding: HALF_UP_2,
    subject: descriptiveSubject,
    courseLevels: [],
  },
  {
    id: "ib_pyp",
    family: "ib",
    name: text("IB Primary Years (PYP)", "البكالوريا الدولية - السنوات الابتدائية (PYP)"),
    description: text(
      "Descriptors from Beginning to Exceeding expectations; no marks or percentages.",
      "أوصاف من «في البداية» إلى «يتجاوز التوقعات»، دون علامات أو نسب مئوية.",
    ),
    scale: null,
    descriptors: [
      { label: text("Exceeding expectations", "يتجاوز التوقعات"), points: 4, notAchieved: false },
      { label: text("Meeting expectations", "يحقق التوقعات"), points: 3, notAchieved: false },
      {
        label: text("Approaching expectations", "يقترب من التوقعات"),
        points: 2,
        notAchieved: false,
      },
      { label: text("Beginning", "في البداية"), points: 1, notAchieved: false },
    ],
    resultFormat: PERCENTAGE,
    overallRounding: HALF_UP_2,
    subject: descriptiveSubject,
    courseLevels: [],
  },
  {
    id: "ib_myp",
    family: "ib",
    name: text("IB Middle Years (MYP)", "البكالوريا الدولية - السنوات المتوسطة (MYP)"),
    description: text(
      "Criteria A–D each out of 8; the total out of 32 gives a grade from 1 to 7. The result is the average grade out of 7.",
      "المعايير من أ إلى د، كل منها من 8؛ ومجموعها من 32 يعطي درجة من 1 إلى 7. النتيجة متوسط الدرجات من 7.",
    ),
    scale: {
      name: same("IB MYP 1–7"),
      bands: MYP_TOTAL_BOUNDARIES.map(([grade, minTotal]) => ({
        label: same(String(grade)),
        minPercentage: (minTotal * 100) / MYP_MAX_TOTAL,
        gpaPoints: grade,
      })),
    },
    descriptors: null,
    resultFormat: { format: "gpa", max: 7 },
    overallRounding: HALF_UP_2,
    subject: {
      method: "total_points",
      maxMarks: MYP_MAX_TOTAL,
      // Grade 3, the lowest grade the MYP certificate accepts.
      passPercentage: (10 * 100) / MYP_MAX_TOTAL,
      // A total out of 32 is a multiple of 3.125%: three decimals keep every boundary exact.
      rounding: { decimals: 3, mode: "half_up" },
      structure: {
        source: "categories",
        categories: (
          [
            ["A", "أ"],
            ["B", "ب"],
            ["C", "ج"],
            ["D", "د"],
          ] as const
        ).map(([letter, arabicLetter]) => ({
          key: `criterion_${letter.toLowerCase()}`,
          name: text(`Criterion ${letter}`, `المعيار ${arabicLetter}`),
          kind: "other" as const,
          weight: null,
          aggregation: "total_points" as const,
          maxMarks: MYP_CRITERION_MAX,
        })),
      },
    },
    courseLevels: [],
  },
  {
    id: "ib_dp",
    family: "ib",
    name: text("IB Diploma subjects (DP)", "البكالوريا الدولية - مواد الدبلوم (DP)"),
    description: text(
      "Subjects graded 1 to 7 with internal assessment and exams. The result is the Diploma total out of 45: the best six subjects plus up to 3 core points from TOK and the Extended Essay, with CAS and the award conditions (editable IB defaults to check against the current IB rules). HL and SL are course levels.",
      "مواد بدرجات من 1 إلى 7 مع التقييم الداخلي والاختبارات. النتيجة مجموع الدبلوم من 45: أفضل ست مواد مع حتى 3 نقاط من نظرية المعرفة والمقالة الموسعة، مع الإبداع والنشاط والخدمة وشروط منح الدبلوم (قيم افتراضية قابلة للتعديل يجب مراجعتها مع قواعد البكالوريا الدولية الحالية). المستوى العالي والعادي مستويات للمادة.",
    ),
    scale: {
      name: same("IB DP 1–7"),
      bands: bands([
        ["7", 80, 7],
        ["6", 70, 6],
        ["5", 60, 5],
        ["4", 50, 4],
        ["3", 40, 3],
        ["2", 25, 2],
        ["1", 0, 1],
      ]),
    },
    descriptors: null,
    resultFormat: { format: "points_total", max: DEFAULT_DIPLOMA_MAX },
    diploma: DEFAULT_DIPLOMA_CONFIG,
    overallRounding: HALF_UP_2,
    subject: numericSubject(40, {
      source: "categories",
      categories: [
        category(
          "internal_assessment",
          text("Internal assessment", "التقييم الداخلي"),
          "project",
          25,
        ),
        category("tests", TESTS, "exam", 25),
        category("end_of_term_exam", END_OF_TERM_EXAM, "final_exam", 50),
      ],
    }),
    courseLevels: [
      { label: text("HL", "المستوى العالي"), gpaBoost: 0 },
      { label: text("SL", "المستوى العادي"), gpaBoost: 0 },
    ],
  },
  {
    id: "american",
    family: "american",
    name: text("American (GPA 4.0)", "الأمريكي (معدل تراكمي من 4.0)"),
    description: text(
      "Letter grades A+ to F on a 4.0 GPA. Every subject is 1 credit and counts by its credits; Honors adds 0.5 and AP adds 1 to the weighted GPA.",
      "درجات بالحروف من A+ إلى F على معدل من 4.0. كل مادة بساعة معتمدة واحدة وتُحتسب بساعاتها؛ يضيف مستوى الشرف 0.5 ومستوى AP نقطة واحدة إلى المعدل الموزون.",
    ),
    scale: {
      name: same("American A+–F"),
      bands: bands([
        ["A+", 97, 4],
        ["A", 93, 4],
        ["A-", 90, 3.7],
        ["B+", 87, 3.3],
        ["B", 83, 3],
        ["B-", 80, 2.7],
        ["C+", 77, 2.3],
        ["C", 73, 2],
        ["C-", 70, 1.7],
        ["D+", 67, 1.3],
        ["D", 65, 1],
        ["F", 0, 0],
      ]),
    },
    descriptors: null,
    resultFormat: { format: "gpa", max: 4 },
    overallRounding: HALF_UP_2,
    subject: numericSubject(
      65,
      {
        source: "categories",
        categories: [
          category("tests", TESTS, "exam", 40),
          category("quizzes", text("Quizzes", "الاختبارات القصيرة"), "quiz", 20),
          category("homework", HOMEWORK, "homework", 15),
          category("classwork", CLASSWORK, "classwork", 15),
          category("projects", text("Projects", "المشاريع"), "project", 10),
        ],
      },
      { credits: { credits: 1, averageWeight: 1 } },
    ),
    courseLevels: [
      { label: text("Standard", "عادي"), gpaBoost: 0 },
      { label: text("Honors", "شرف"), gpaBoost: 0.5 },
      { label: same("AP"), gpaBoost: 1 },
    ],
  },
  {
    id: "french",
    family: "french",
    name: text("French (out of 20)", "الفرنسي (من 20)"),
    description: text(
      "Marks out of 20, passing at 10, with the mentions Passable, Assez bien, Bien and Très bien. Subjects follow the school's exam system.",
      "علامات من 20 والنجاح من 10، مع التقديرات: مقبول، مستحسن، حسن، حسن جدًا. تتبع المواد نظام الاختبارات في المدرسة.",
    ),
    scale: {
      name: text("Mentions (out of 20)", "التقديرات (من 20)"),
      bands: [
        { label: text("Très bien", "حسن جدًا"), minPercentage: 80, gpaPoints: null },
        { label: text("Bien", "حسن"), minPercentage: 70, gpaPoints: null },
        { label: text("Assez bien", "مستحسن"), minPercentage: 60, gpaPoints: null },
        { label: text("Passable", "مقبول"), minPercentage: 50, gpaPoints: null },
        { label: text("Insuffisant", "غير كافٍ"), minPercentage: 0, gpaPoints: null },
      ],
    },
    descriptors: null,
    resultFormat: { format: "out_of", max: 20 },
    overallRounding: HALF_UP_2,
    subject: numericSubject(50, { source: "exam_structure" }, { maxMarks: 20 }),
    courseLevels: [],
  },
  {
    id: "irish_junior_cycle",
    family: "irish",
    name: text("Irish Junior Cycle", "دورة المرحلة الإعدادية الأيرلندية"),
    description: text(
      "Junior Cycle descriptors from Distinction to Not Graded. A subject passes at Achieved (40%).",
      "أوصاف الدورة الإعدادية من «امتياز» إلى «غير مُقيَّم». تنجح المادة عند «مُنجَز» (40%).",
    ),
    scale: {
      name: same("Junior Cycle"),
      bands: [
        { label: text("Distinction", "امتياز"), minPercentage: 90, gpaPoints: null },
        { label: text("Higher Merit", "جدارة عليا"), minPercentage: 75, gpaPoints: null },
        { label: text("Merit", "جدارة"), minPercentage: 55, gpaPoints: null },
        { label: text("Achieved", "مُنجَز"), minPercentage: 40, gpaPoints: null },
        {
          label: text("Partially Achieved", "مُنجَز جزئيًا"),
          minPercentage: 20,
          gpaPoints: null,
        },
        { label: text("Not Graded", "غير مُقيَّم"), minPercentage: 0, gpaPoints: null },
      ],
    },
    descriptors: null,
    resultFormat: PERCENTAGE,
    overallRounding: HALF_UP_2,
    subject: numericSubject(40, { source: "exam_structure" }),
    courseLevels: [
      { label: text("Higher", "عالٍ"), gpaBoost: 0 },
      { label: text("Ordinary", "عادي"), gpaBoost: 0 },
    ],
  },
  {
    id: "irish_leaving_certificate",
    family: "irish",
    name: text("Irish Leaving Certificate", "شهادة التخرج الأيرلندية"),
    description: text(
      "Grades H1 to H8 in steps of 10%. A subject passes at H6 (40%).",
      "الدرجات من H1 إلى H8 بفارق 10% لكل درجة. تنجح المادة عند H6 (40%).",
    ),
    scale: {
      name: same("Leaving Certificate H1–H8"),
      bands: bands([
        ["H1", 90, null],
        ["H2", 80, null],
        ["H3", 70, null],
        ["H4", 60, null],
        ["H5", 50, null],
        ["H6", 40, null],
        ["H7", 30, null],
        ["H8", 0, null],
      ]),
    },
    descriptors: null,
    resultFormat: PERCENTAGE,
    overallRounding: HALF_UP_2,
    subject: numericSubject(40, { source: "exam_structure" }),
    courseLevels: [
      { label: text("Higher", "عالٍ"), gpaBoost: 0 },
      { label: text("Ordinary", "عادي"), gpaBoost: 0 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const CURRICULUM_TEMPLATE_IDS: readonly CurriculumTemplateId[] = CURRICULUM_TEMPLATES.map(
  (template) => template.id,
);

export function getCurriculumTemplate(id: string): CurriculumTemplate | null {
  return CURRICULUM_TEMPLATES.find((template) => template.id === id) ?? null;
}

export function localize(value: LocalizedText, locale: TemplateLocale): string {
  return locale === "ar" ? value.ar : value.en;
}

/** The template's scale bands in `locale`, highest first; empty for a descriptor template. */
export function templateScaleBands(
  template: CurriculumTemplate,
  locale: TemplateLocale,
): GradeBand[] {
  return (template.scale?.bands ?? []).map((band) => ({
    label: localize(band.label, locale),
    minPercentage: band.minPercentage,
    gpaPoints: band.gpaPoints,
  }));
}

/**
 * Each of `count` terms' share of the year, totalling exactly 100: equal shares cut to two
 * decimals, the last term taking the remainder (three terms: 33.33, 33.33, 33.34).
 */
export function equalTermWeights(count: number): number[] {
  if (count <= 0) return [];
  const share = Math.floor((100 / count) * 100) / 100;
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? Math.round((100 - share * (count - 1)) * 100) / 100 : share,
  );
}

export interface TemplateTermStructure {
  /** One weight per term, in term order; empty for total-points and descriptive subjects. */
  termWeights: number[];
  categories: {
    key: string;
    name: string;
    kind: CategoryKind;
    weight: number | null;
    aggregation: CategoryAggregation;
    sortOrder: number;
  }[];
  /** One assessment per category and term. */
  assessments: {
    categoryKey: string;
    termIndex: number;
    name: string;
    maxMarks: number;
    sortOrder: number;
  }[];
}

/**
 * A template's own categories laid out over `termCount` terms. Only weighted subjects weight
 * their terms; total-points subjects sum every term's points and descriptive ones have no weights.
 */
export function buildTemplateTermStructure(
  method: GradingMethod,
  categories: readonly TemplateCategory[],
  termCount: number,
  locale: TemplateLocale,
): TemplateTermStructure {
  const terms = Array.from({ length: Math.max(termCount, 0) }, (_, index) => index);
  return {
    termWeights: method === "weighted" ? equalTermWeights(termCount) : [],
    categories: categories.map((item, index) => ({
      key: item.key,
      name: localize(item.name, locale),
      kind: item.kind,
      weight: method === "weighted" ? item.weight : null,
      aggregation: item.aggregation,
      sortOrder: index,
    })),
    assessments: terms.flatMap((termIndex) =>
      categories.map((item, index) => ({
        categoryKey: item.key,
        termIndex,
        name: localize(item.name, locale),
        maxMarks: item.maxMarks,
        sortOrder: index,
      })),
    ),
  };
}
