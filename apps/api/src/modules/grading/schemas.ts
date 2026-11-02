import { z } from "@hono/zod-openapi";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Params and shared enums
// ---------------------------------------------------------------------------

const pathUuid = (name: string, description: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: "path" }, description });

export const yearIdParamSchema = z
  .object({ yearId: pathUuid("yearId", "Academic year UUID.") })
  .openapi("GradingYearIdParam");
export const scaleIdParamSchema = z
  .object({ scaleId: pathUuid("scaleId", "Grading scale UUID.") })
  .openapi("GradeScaleIdParam");
export const programParamSchema = z
  .object({
    yearId: pathUuid("yearId", "Academic year UUID."),
    gradeLevelId: pathUuid("gradeLevelId", "Grade level UUID."),
  })
  .openapi("GradeProgramParam");
export const configIdParamSchema = z
  .object({ configId: pathUuid("configId", "Subject configuration UUID.") })
  .openapi("SubjectConfigIdParam");
export const gradingSectionParamSchema = z
  .object({ sectionId: pathUuid("sectionId", "Section UUID.") })
  .openapi("GradingSectionIdParam");
export const sectionSubjectParamSchema = z
  .object({
    sectionId: pathUuid("sectionId", "Section UUID."),
    subjectId: pathUuid("subjectId", "Subject UUID."),
  })
  .openapi("SectionSubjectParam");
export const assignmentIdParamSchema = z
  .object({ assignmentId: pathUuid("assignmentId", "Teacher assignment UUID.") })
  .openapi("TeacherAssignmentIdParam");
export const sheetIdParamSchema = z
  .object({ sheetId: pathUuid("sheetId", "Mark sheet UUID.") })
  .openapi("MarkSheetIdParam");
export const assessmentIdParamSchema = z
  .object({ assessmentId: pathUuid("assessmentId", "Assessment UUID.") })
  .openapi("GradingAssessmentIdParam");
export const finalizationIdParamSchema = z
  .object({ finalizationId: pathUuid("finalizationId", "Result finalization UUID.") })
  .openapi("FinalizationIdParam");
export const certificateIdParamSchema = z
  .object({ certificateId: pathUuid("certificateId", "Certificate UUID.") })
  .openapi("CertificateIdParam");
export const gradingStudentParamSchema = z
  .object({ studentId: pathUuid("studentId", "Student UUID.") })
  .openapi("GradingStudentIdParam");

export const gradingConfigStatusSchema = z
  .enum(["draft", "active", "finalized", "archived"])
  .openapi({ description: "Lifecycle of a year's grading configuration." });
const roundingModeSchema = z.enum(["half_up", "half_even", "floor", "ceil"]);
const requirementSchema = z.enum(["mandatory", "optional", "elective"]);
const categoryKindSchema = z.enum([
  "homework",
  "quiz",
  "classwork",
  "project",
  "practical",
  "participation",
  "exam",
  "first_period",
  "second_period",
  "midterm",
  "final_exam",
  "other",
]);
const categoryScopeSchema = z.enum(["term", "annual"]);
const aggregationSchema = z.enum(["weighted_average", "total_points"]);
const markStatusSchema = z.enum(["graded", "absent", "excused", "not_applicable"]);
const percentage = z.number().min(0).max(100);

export const validationIssueSchema = z
  .object({
    code: z.string(),
    severity: z.enum(["error", "warning"]),
    message: z.string(),
    ref: z.string().optional(),
  })
  .openapi("GradingValidationIssue");

const weightSummarySchema = z
  .object({ termCategoryTotal: z.number(), annualTotal: z.number(), valid: z.boolean() })
  .openapi("GradingWeightSummary");

// ---------------------------------------------------------------------------
// Year status, overview, copy
// ---------------------------------------------------------------------------

export const publishIssueSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string(),
    message: z.string(),
    grade_level_id: uuidSchema.optional(),
    section_id: uuidSchema.optional(),
    subject_id: uuidSchema.optional(),
    config_id: uuidSchema.optional(),
  })
  .openapi("GradingPublishIssue");

export const setYearStatusBodySchema = z
  .object({ status: gradingConfigStatusSchema })
  .openapi("SetGradingStatusBody");

export const yearStatusResultSchema = z
  .object({ status: gradingConfigStatusSchema, issues: z.array(publishIssueSchema) })
  .openapi("GradingStatusResult");

export const publishCheckSchema = z
  .object({ ready: z.boolean(), issues: z.array(publishIssueSchema) })
  .openapi("GradingPublishCheck");

export const copyYearBodySchema = z
  .object({
    source_year_id: uuidSchema,
    include_teacher_assignments: z.boolean().default(false),
  })
  .openapi("CopyGradingYearBody");

export const copyYearSummarySchema = z
  .object({
    source_year_id: uuidSchema,
    target_year_id: uuidSchema,
    scales: z.number().int(),
    grade_programs: z.number().int(),
    sections_created: z.number().int(),
    sections_reused: z.number().int(),
    subject_configs: z.number().int(),
    categories: z.number().int(),
    assessments: z.number().int(),
    teacher_assignments: z.number().int(),
    warnings: z.array(z.string()),
  })
  .openapi("CopyGradingYearSummary");

export const gradingOverviewSchema = z
  .object({
    year: z
      .object({
        id: uuidSchema,
        code: z.string(),
        name: z.string(),
        grading_config_status: gradingConfigStatusSchema,
      })
      .openapi("GradingOverviewYearInfo"),
    grades: z.array(
      z
        .object({
          grade_level_id: uuidSchema,
          grade_level_name: z.string(),
          grade_scale_id: uuidSchema.nullable(),
          mark_approval_required: z.boolean(),
          subjects: z.array(
            z
              .object({
                config_id: uuidSchema,
                subject_id: uuidSchema,
                subject_name: z.string(),
                requirement: requirementSchema,
                valid: z.boolean(),
                error_count: z.number().int(),
                warning_count: z.number().int(),
                term_category_total: z.number(),
                annual_total: z.number(),
                revision: z.number().int(),
              })
              .openapi("GradingOverviewSubject"),
          ),
          sections: z.array(
            z
              .object({
                section_id: uuidSchema,
                name: z.string(),
                student_count: z.number().int(),
                subjects: z.array(
                  z
                    .object({
                      subject_id: uuidSchema,
                      subject_name: z.string(),
                      source: z.enum(["inherited", "override", "section_only", "excluded"]),
                      config_id: uuidSchema.nullable(),
                      outdated: z.boolean(),
                      teacher_names: z.array(z.string()),
                    })
                    .openapi("GradingOverviewSectionSubject"),
                ),
                students_incomplete: z.number().int().nullable(),
                annual_finalization_id: uuidSchema.nullable(),
                term_finalization_ids: z.array(uuidSchema),
                certificates: z
                  .object({
                    ready: z.number().int(),
                    issued: z.number().int(),
                    needs_reissue: z.number().int(),
                    blocked: z.number().int(),
                  })
                  .nullable(),
              })
              .openapi("GradingOverviewSection"),
          ),
        })
        .openapi("GradingOverviewGrade"),
    ),
    counts: z
      .object({
        grades: z.number().int(),
        subjects_invalid: z.number().int(),
        sections: z.number().int(),
        sections_with_overrides: z.number().int(),
        outdated_overrides: z.number().int(),
        missing_teacher_assignments: z.number().int(),
        students_with_incomplete_marks: z.number().int(),
        mark_sheets_awaiting_approval: z.number().int(),
        proposed_assessments: z.number().int(),
        certificates_ready: z.number().int(),
        certificates_blocked: z.number().int(),
        certificates_needing_reissue: z.number().int(),
      })
      .openapi("GradingOverviewCounts"),
    issues: z.array(publishIssueSchema),
  })
  .openapi("GradingOverview");

// ---------------------------------------------------------------------------
// Scales and programs
// ---------------------------------------------------------------------------

const bandSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    min_percentage: percentage,
    gpa_points: z.number().min(0).max(100).nullable(),
  })
  .openapi("GradeScaleBand");

export const scaleBodySchema = z
  .object({ name: z.string().trim().min(1).max(100), bands: z.array(bandSchema).min(1).max(30) })
  .openapi("GradeScaleBody");

export const scaleSchema = z
  .object({
    id: uuidSchema,
    academic_year_id: uuidSchema,
    name: z.string(),
    bands: z.array(bandSchema),
    issues: z.array(validationIssueSchema),
  })
  .openapi("GradeScale");

export const scaleListSchema = z.object({ scales: z.array(scaleSchema) }).openapi("GradeScaleList");

export const programBodySchema = z
  .object({
    grade_scale_id: uuidSchema.nullable().optional(),
    max_failed_subjects_for_supplementary: z.number().int().min(0).max(50).optional(),
    mark_approval_required: z.boolean().optional(),
    average_rounding_decimals: z.number().int().min(0).max(4).optional(),
    average_rounding_mode: roundingModeSchema.optional(),
  })
  .openapi("GradeProgramBody");

export const programSchema = z
  .object({
    id: uuidSchema,
    academic_year_id: uuidSchema,
    grade_level_id: uuidSchema,
    grade_level_name: z.string(),
    grade_scale_id: uuidSchema.nullable(),
    max_failed_subjects_for_supplementary: z.number().int(),
    mark_approval_required: z.boolean(),
    average_rounding_decimals: z.number().int(),
    average_rounding_mode: roundingModeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("GradeProgram");

export const programListSchema = z
  .object({ programs: z.array(programSchema) })
  .openapi("GradeProgramList");

// ---------------------------------------------------------------------------
// Subject configs
// ---------------------------------------------------------------------------

const configFields = {
  requirement: requirementSchema.default("mandatory"),
  include_in_average: z.boolean().default(true),
  include_on_certificate: z.boolean().default(true),
  average_weight: z.number().positive().max(100).default(1),
  grading_method: z.enum(["weighted", "total_points"]).default("weighted"),
  max_marks: z.number().positive().max(100000).default(100),
  pass_percentage: percentage.default(50),
  final_exam_pass_percentage: percentage.nullable().default(null),
  grade_scale_id: uuidSchema.nullable().default(null),
  rounding_decimals: z.number().int().min(0).max(4).default(2),
  rounding_mode: roundingModeSchema.default("half_up"),
  missing_mark_policy: z.enum(["incomplete", "zero"]).default("incomplete"),
  absent_policy: z.enum(["incomplete", "zero"]).default("incomplete"),
  retake_policy: z.enum(["none", "replace", "highest", "capped"]).default("none"),
  retake_cap_percentage: z.number().gt(0).max(100).nullable().default(null),
  teachers_can_add_assessments: z.boolean().default(false),
  teacher_assessments_require_approval: z.boolean().default(true),
  instructions: z.string().trim().min(1).max(4000).nullable().default(null),
  term_weights: z
    .array(
      z
        .object({ term_id: uuidSchema, weight: percentage })
        .openapi("GradingConfigFieldsTermWeight"),
    )
    .max(12)
    .default([]),
  categories: z
    .array(
      z
        .object({
          ref: z.string().min(1).max(64).openapi({
            description: "An existing category id to keep, or any client key for a new category.",
          }),
          name: z.string().trim().min(1).max(100),
          kind: categoryKindSchema.default("other"),
          scope: categoryScopeSchema.default("annual"),
          weight: percentage.nullable(),
          aggregation: aggregationSchema.default("weighted_average"),
          drop_lowest: z.number().int().min(0).max(20).default(0),
          sort_order: z.number().int().min(0).max(32767).default(0),
        })
        .openapi("GradingConfigFieldsCategory"),
    )
    .max(30),
  assessments: z
    .array(
      z
        .object({
          id: uuidSchema
            .optional()
            .openapi({ description: "Keep an existing assessment (and its marks)." }),
          category_ref: z.string().min(1).max(64),
          term_id: uuidSchema.nullable().default(null),
          name: z.string().trim().min(1).max(120),
          max_marks: z.number().positive().max(100000),
          weight: z.number().positive().max(1000).default(1),
          is_mandatory: z.boolean().default(true),
          assessment_date: dateSchema.nullable().default(null),
          due_date: dateSchema.nullable().default(null),
          sort_order: z.number().int().min(0).max(32767).default(0),
        })
        .openapi("GradingConfigFieldsAssessment"),
    )
    .max(200),
};

export const createSubjectConfigBodySchema = z
  .object({
    subject_id: uuidSchema,
    section_id: uuidSchema.nullable().default(null).openapi({
      description: "Set only for a subject taught in one section and not in the grade as a whole.",
    }),
    ...configFields,
  })
  .openapi("CreateSubjectConfigBody");

export const updateSubjectConfigBodySchema = z
  .object({
    ...configFields,
    confirm_impact: z.boolean().default(false).openapi({
      description: "Required when the change recalculates marks that are already recorded.",
    }),
    expected_updated_at: dateTimeSchema.optional(),
  })
  .openapi("UpdateSubjectConfigBody");

export const subjectConfigSchema = z
  .object({
    id: uuidSchema,
    academic_year_id: uuidSchema,
    grade_level_id: uuidSchema,
    section_id: uuidSchema.nullable(),
    subject: z
      .object({ id: uuidSchema, code: z.string(), name: z.string() })
      .openapi("SubjectConfigSubject"),
    requirement: requirementSchema,
    include_in_average: z.boolean(),
    include_on_certificate: z.boolean(),
    average_weight: z.number(),
    grading_method: z.enum(["weighted", "total_points"]),
    max_marks: z.number(),
    pass_percentage: z.number(),
    final_exam_pass_percentage: z.number().nullable(),
    grade_scale_id: uuidSchema.nullable(),
    effective_scale_name: z.string().nullable(),
    rounding_decimals: z.number().int(),
    rounding_mode: roundingModeSchema,
    missing_mark_policy: z.enum(["incomplete", "zero"]),
    absent_policy: z.enum(["incomplete", "zero"]),
    retake_policy: z.enum(["none", "replace", "highest", "capped"]),
    retake_cap_percentage: z.number().nullable(),
    teachers_can_add_assessments: z.boolean(),
    teacher_assessments_require_approval: z.boolean(),
    instructions: z.string().nullable(),
    is_excluded: z.boolean(),
    revision: z.number().int(),
    based_on_revision: z.number().int().nullable(),
    term_weights: z.array(
      z
        .object({
          term_id: uuidSchema,
          term_name: z.string(),
          sequence_number: z.number().int(),
          weight: z.number(),
        })
        .openapi("SubjectConfigTermWeight"),
    ),
    categories: z.array(
      z
        .object({
          id: uuidSchema,
          name: z.string(),
          kind: categoryKindSchema,
          scope: categoryScopeSchema,
          weight: z.number().nullable(),
          aggregation: aggregationSchema,
          drop_lowest: z.number().int(),
          sort_order: z.number().int(),
        })
        .openapi("SubjectConfigCategory"),
    ),
    assessments: z.array(
      z
        .object({
          id: uuidSchema,
          category_id: uuidSchema,
          term_id: uuidSchema.nullable(),
          section_id: uuidSchema.nullable(),
          name: z.string(),
          max_marks: z.number(),
          weight: z.number(),
          is_mandatory: z.boolean(),
          assessment_date: z.string().nullable(),
          due_date: z.string().nullable(),
          status: z.enum(["active", "proposed", "rejected"]),
          sort_order: z.number().int(),
          mark_count: z.number().int(),
        })
        .openapi("SubjectConfigAssessment"),
    ),
    weight_summary: weightSummarySchema,
    issues: z.array(validationIssueSchema),
    valid: z.boolean(),
    mark_count: z.number().int(),
    updated_at: dateTimeSchema,
  })
  .openapi("SubjectConfig");

export const subjectConfigListSchema = z
  .object({ configs: z.array(subjectConfigSchema) })
  .openapi("SubjectConfigList");

export const saveSubjectConfigResultSchema = z
  .object({ config: subjectConfigSchema, affected_section_ids: z.array(uuidSchema) })
  .openapi("SaveSubjectConfigResult");

export const configImpactSchema = z
  .object({
    config_id: uuidSchema,
    is_grade_default: z.boolean(),
    revision: z.number().int(),
    mark_count: z.number().int(),
    inheriting_sections: z.array(
      z
        .object({ section_id: uuidSchema, name: z.string(), mark_count: z.number().int() })
        .openapi("GradingConfigImpactInheritingSection"),
    ),
    overriding_sections: z.array(
      z
        .object({
          section_id: uuidSchema,
          name: z.string(),
          config_id: uuidSchema,
          excluded: z.boolean(),
          based_on_revision: z.number().int().nullable(),
          outdated: z.boolean(),
        })
        .openapi("GradingConfigImpactOverridingSection"),
    ),
    finalized_sections: z.array(
      z
        .object({ section_id: uuidSchema, name: z.string(), term_id: uuidSchema.nullable() })
        .openapi("GradingConfigImpactFinalizedSection"),
    ),
  })
  .openapi("SubjectConfigImpact");

export const sectionSubjectsSchema = z
  .object({
    section: z
      .object({
        id: uuidSchema,
        name: z.string(),
        academic_year_id: uuidSchema,
        grade_level_id: uuidSchema,
        grade_level_name: z.string(),
      })
      .openapi("SectionSubjectsSection"),
    subjects: z.array(
      z
        .object({
          subject_id: uuidSchema,
          subject_code: z.string(),
          subject_name: z.string(),
          source: z.enum(["inherited", "override", "section_only", "excluded"]),
          config_id: uuidSchema.nullable(),
          grade_config_id: uuidSchema.nullable(),
          override_config_id: uuidSchema.nullable(),
          requirement: requirementSchema,
          outdated: z.boolean(),
          grade_revision: z.number().int().nullable(),
          based_on_revision: z.number().int().nullable(),
          teachers: z.array(
            z
              .object({
                teacher_id: uuidSchema,
                name: z.string(),
                assignment_id: uuidSchema.nullable(),
              })
              .openapi("SectionSubjectsTeacher"),
          ),
        })
        .openapi("SectionSubjectsSubject"),
    ),
  })
  .openapi("SectionGradingSubjects");

export const sectionOverrideBodySchema = z
  .object({
    mode: z.enum(["customize", "exclude"]).openapi({
      description:
        "customize: copy the grade default into an editable section configuration (marks move with it). exclude: the section does not offer the subject.",
    }),
  })
  .openapi("SectionOverrideBody");

// ---------------------------------------------------------------------------
// Teachers and electives
// ---------------------------------------------------------------------------

export const teacherAssignmentBodySchema = z
  .object({ section_id: uuidSchema, subject_id: uuidSchema, teacher_id: uuidSchema })
  .openapi("TeacherAssignmentBody");

export const teacherAssignmentSchema = z
  .object({
    id: uuidSchema,
    academic_year_id: uuidSchema,
    section_id: uuidSchema,
    section_name: z.string(),
    grade_level_name: z.string(),
    subject_id: uuidSchema,
    subject_name: z.string(),
    teacher_id: uuidSchema,
    teacher_name: z.string(),
  })
  .openapi("TeacherAssignment");

export const teacherAssignmentListSchema = z
  .object({ assignments: z.array(teacherAssignmentSchema) })
  .openapi("TeacherAssignmentList");

export const subjectEnrollmentBodySchema = z
  .object({
    student_id: uuidSchema,
    subject_id: uuidSchema,
    status: z.enum(["enrolled", "exempt", "none"]),
    reason: z.string().trim().min(1).max(1000).nullable().default(null),
  })
  .openapi("SubjectEnrollmentBody");

export const subjectEnrollmentListSchema = z
  .object({
    enrollments: z.array(
      z
        .object({
          student_id: uuidSchema,
          subject_id: uuidSchema,
          status: z.enum(["enrolled", "exempt"]),
          reason: z.string().nullable(),
          updated_at: dateTimeSchema,
        })
        .openapi("SubjectEnrollmentListEnrollment"),
    ),
  })
  .openapi("SubjectEnrollmentList");

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export const myAssignmentsQuerySchema = z
  .object({ academic_year_id: uuidSchema.optional() })
  .openapi("MyGradingAssignmentsQuery");

const sheetStatusSchema = z.enum(["draft", "submitted", "approved", "returned"]);

export const myAssignmentsSchema = z
  .object({
    assignments: z.array(
      z
        .object({
          academic_year_id: uuidSchema,
          section_id: uuidSchema,
          section_name: z.string(),
          grade_level_name: z.string(),
          subject_id: uuidSchema,
          subject_name: z.string(),
          config_id: uuidSchema,
          sheets: z.array(
            z
              .object({ term_id: uuidSchema.nullable(), status: sheetStatusSchema })
              .openapi("MyAssignmentsSheet"),
          ),
        })
        .openapi("MyAssignmentsAssignment"),
    ),
  })
  .openapi("MyGradingAssignments");

const previewSchema = z
  .object({
    status: z.enum(["complete", "incomplete"]),
    percentage: z.number().nullable(),
    provisional_percentage: z.number().nullable(),
    grade_label: z.string().nullable(),
    passed: z.boolean().nullable(),
    missing_assessment_ids: z.array(uuidSchema),
    terms: z.array(
      z
        .object({
          term_id: uuidSchema.nullable(),
          percentage: z.number().nullable(),
          incomplete: z.boolean(),
        })
        .openapi("GradingPreviewTerm"),
    ),
  })
  .openapi("MarkPreview");

export const markSheetSchema = z
  .object({
    section: z
      .object({
        id: uuidSchema,
        name: z.string(),
        grade_level_name: z.string(),
        academic_year_id: uuidSchema,
      })
      .openapi("MarkSheetSection"),
    subject: z
      .object({ id: uuidSchema, code: z.string(), name: z.string() })
      .openapi("MarkSheetSubject"),
    config_id: uuidSchema,
    source: z.string(),
    year_status: gradingConfigStatusSchema,
    can_edit_marks: z.boolean(),
    can_add_assessments: z.boolean(),
    config: z
      .object({
        grading_method: z.enum(["weighted", "total_points"]),
        max_marks: z.number(),
        pass_percentage: z.number(),
        final_exam_pass_percentage: z.number().nullable(),
        rounding_decimals: z.number().int(),
        missing_mark_policy: z.string(),
        absent_policy: z.string(),
        retake_policy: z.string(),
        instructions: z.string().nullable(),
        weight_summary: weightSummarySchema,
      })
      .openapi("MarkSheetConfig"),
    terms: z.array(
      z
        .object({
          id: uuidSchema,
          name: z.string(),
          sequence_number: z.number().int(),
          weight: z.number(),
        })
        .openapi("MarkSheetTerm"),
    ),
    categories: z.array(
      z
        .object({
          id: uuidSchema,
          name: z.string(),
          kind: z.string(),
          scope: z.string(),
          weight: z.number().nullable(),
          aggregation: z.string(),
          drop_lowest: z.number().int(),
        })
        .openapi("MarkSheetCategory"),
    ),
    assessments: z.array(
      z
        .object({
          id: uuidSchema,
          category_id: uuidSchema,
          term_id: uuidSchema.nullable(),
          name: z.string(),
          max_marks: z.number(),
          weight: z.number(),
          is_mandatory: z.boolean(),
          assessment_date: z.string().nullable(),
          due_date: z.string().nullable(),
          status: z.string(),
          section_specific: z.boolean(),
        })
        .openapi("MarkSheetAssessment"),
    ),
    mark_sheets: z.array(
      z
        .object({
          id: uuidSchema.nullable(),
          term_id: uuidSchema.nullable(),
          status: sheetStatusSchema,
          submitted_at: dateTimeSchema.nullable(),
          decided_at: dateTimeSchema.nullable(),
          return_reason: z.string().nullable(),
        })
        .openapi("MarkSheetPeriod"),
    ),
    students: z.array(
      z
        .object({
          student_id: uuidSchema,
          first_name: z.string(),
          last_name: z.string(),
          admission_number: z.string(),
          status: z.enum(["enrolled", "exempt"]),
          marks: z.array(
            z
              .object({
                id: uuidSchema,
                assessment_id: uuidSchema,
                attempt: z.number().int(),
                status: markStatusSchema,
                score: z.number().nullable(),
                remarks: z.string().nullable(),
                updated_at: dateTimeSchema,
              })
              .openapi("MarkSheetMark"),
          ),
          preview: previewSchema.nullable(),
        })
        .openapi("MarkSheetStudent"),
    ),
  })
  .openapi("MarkSheet");

export const saveMarksBodySchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            assessment_id: uuidSchema,
            student_id: uuidSchema,
            attempt: z.union([z.literal(1), z.literal(2)]).default(1),
            status: z.enum(["graded", "absent", "excused", "not_applicable", "pending"]),
            score: z.number().min(0).max(100000).nullable().default(null),
            remarks: z.string().trim().min(1).max(1000).nullable().default(null),
            expected_updated_at: dateTimeSchema.nullable().optional(),
          })
          .openapi("GradingSaveMarksBodyEntry"),
      )
      .min(1)
      .max(500),
  })
  .openapi("SaveMarksBody");

export const saveMarksResultSchema = z
  .object({ saved: z.number().int(), sheet: markSheetSchema })
  .openapi("SaveMarksResult");

export const addAssessmentBodySchema = z
  .object({
    category_id: uuidSchema,
    term_id: uuidSchema.nullable().default(null),
    name: z.string().trim().min(1).max(120),
    max_marks: z.number().positive().max(100000),
    weight: z.number().positive().max(1000).default(1),
    is_mandatory: z.boolean().default(true),
    assessment_date: dateSchema.nullable().default(null),
    due_date: dateSchema.nullable().default(null),
  })
  .openapi("AddSectionAssessmentBody");

export const addAssessmentResultSchema = z
  .object({ id: uuidSchema, status: z.enum(["active", "proposed"]) })
  .openapi("AddSectionAssessmentResult");

export const submitSheetBodySchema = z
  .object({ term_id: uuidSchema.nullable().default(null) })
  .openapi("SubmitMarkSheetBody");

export const markSheetRowSchema = z
  .object({
    id: uuidSchema,
    section_id: uuidSchema,
    subject_id: uuidSchema,
    term_id: uuidSchema.nullable(),
    status: sheetStatusSchema,
    submitted_by_user_id: uuidSchema.nullable(),
    submitted_at: dateTimeSchema.nullable(),
    decided_by_user_id: uuidSchema.nullable(),
    decided_at: dateTimeSchema.nullable(),
    return_reason: z.string().nullable(),
    updated_at: dateTimeSchema,
  })
  .openapi("MarkSheetStatus");

export const markSheetQuerySchema = z
  .object({ status: sheetStatusSchema.optional() })
  .openapi("MarkSheetQuery");

export const markSheetListSchema = z
  .object({
    sheets: z.array(
      markSheetRowSchema.extend({
        section_name: z.string(),
        grade_level_name: z.string(),
        subject_name: z.string(),
        term_name: z.string().nullable(),
        submitted_by_name: z.string().nullable(),
      }),
    ),
  })
  .openapi("MarkSheetList");

export const decideSheetBodySchema = z
  .object({
    action: z.enum(["approve", "return", "reopen"]),
    reason: z.string().trim().min(1).max(2000).nullable().default(null),
  })
  .openapi("DecideMarkSheetBody");

export const decideAssessmentBodySchema = z
  .object({ action: z.enum(["approve", "reject"]) })
  .openapi("DecideAssessmentBody");

export const proposedAssessmentListSchema = z
  .object({
    assessments: z.array(
      z
        .object({
          id: uuidSchema,
          name: z.string(),
          subject_name: z.string(),
          section_id: uuidSchema.nullable(),
          section_name: z.string().nullable(),
          max_marks: z.number(),
          created_by_name: z.string().nullable(),
          created_at: dateTimeSchema,
        })
        .openapi("ProposedAssessmentListAssessment"),
    ),
  })
  .openapi("ProposedAssessmentList");

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const periodQuerySchema = z
  .object({ term_id: uuidSchema.optional() })
  .openapi("ResultPeriodQuery");

export const resultPreviewSchema = z
  .object({
    section_id: uuidSchema,
    term_id: uuidSchema.nullable(),
    unapproved_sheets: z.array(z.string()),
    ready: z.boolean(),
    students: z.array(
      z
        .object({
          student_id: uuidSchema,
          first_name: z.string(),
          last_name: z.string(),
          admission_number: z.string(),
          status: z.enum(["complete", "incomplete"]),
          average_percentage: z.number().nullable(),
          total_obtained: z.number().nullable(),
          total_max: z.number().nullable(),
          grade_label: z.string().nullable(),
          subjects_failed: z.number().int(),
          academic_status: z.enum(["promoted", "supplementary", "retained", "incomplete"]),
          subjects: z.array(
            z
              .object({
                subject_id: uuidSchema,
                subject_name: z.string(),
                exempt: z.boolean(),
                status: z.enum(["complete", "incomplete", "exempt"]),
                percentage: z.number().nullable(),
                provisional_percentage: z.number().nullable(),
                marks_obtained: z.number().nullable(),
                max_marks: z.number(),
                grade_label: z.string().nullable(),
                passed: z.boolean().nullable(),
                missing_assessments: z.array(z.string()),
              })
              .openapi("ResultPreviewSubject"),
          ),
        })
        .openapi("ResultPreviewStudent"),
    ),
  })
  .openapi("ResultPreview");

export const finalizeBodySchema = z
  .object({
    term_id: uuidSchema.nullable().default(null),
    allow_incomplete: z.boolean().default(false).openapi({
      description:
        "Finalize even though some students are incomplete; those are stored as incomplete and cannot receive a certificate.",
    }),
  })
  .openapi("FinalizeResultsBody");

export const finalizationSchema = z
  .object({
    id: uuidSchema,
    academic_year_id: uuidSchema,
    section_id: uuidSchema,
    term_id: uuidSchema.nullable(),
    version: z.number().int(),
    status: z.enum(["finalized", "superseded"]),
    finalized_by_user_id: uuidSchema,
    finalized_at: dateTimeSchema,
    supersedes_id: uuidSchema.nullable(),
    correction_reason: z.string().nullable(),
    superseded_at: dateTimeSchema.nullable(),
  })
  .openapi("ResultFinalization");

export const finalizationQuerySchema = z
  .object({ academic_year_id: uuidSchema.optional(), section_id: uuidSchema.optional() })
  .openapi("FinalizationQuery");

export const finalizationListSchema = z
  .object({
    finalizations: z.array(
      finalizationSchema.extend({
        section_name: z.string(),
        grade_level_name: z.string(),
        term_name: z.string().nullable(),
      }),
    ),
  })
  .openapi("ResultFinalizationList");

const storedSubjectResultSchema = z
  .object({
    subject_id: uuidSchema,
    subject_code: z.string(),
    subject_name: z.string(),
    status: z.enum(["complete", "incomplete", "exempt"]),
    percentage: z.number().nullable(),
    marks_obtained: z.number().nullable(),
    max_marks: z.number(),
    grade_label: z.string().nullable(),
    gpa_points: z.number().nullable(),
    passed: z.boolean().nullable(),
    include_in_average: z.boolean(),
    include_on_certificate: z.boolean(),
    requirement: z.string(),
    terms: z.array(
      z
        .object({ term_id: uuidSchema.nullable(), percentage: z.number().nullable() })
        .openapi("GradingStoredSubjectResultTerm"),
    ),
    fail_reasons: z.array(
      z
        .object({
          code: z.enum(["BELOW_PASS_PERCENTAGE", "FINAL_EXAM_BELOW_REQUIRED"]),
          categoryId: z.string().optional(),
          required: z.number(),
          actual: z.number().nullable(),
        })
        .openapi("GradingStoredSubjectResultFailReason"),
    ),
  })
  .openapi("FinalizedSubjectResult");

export const storedStudentResultSchema = z
  .object({
    student_id: uuidSchema,
    first_name: z.string(),
    last_name: z.string(),
    admission_number: z.string(),
    status: z.enum(["complete", "incomplete"]),
    average_percentage: z.number().nullable(),
    total_obtained: z.number().nullable(),
    total_max: z.number().nullable(),
    grade_label: z.string().nullable(),
    subjects_failed: z.number().int(),
    academic_status: z.enum(["promoted", "supplementary", "retained", "incomplete"]),
    subjects: z.array(storedSubjectResultSchema),
  })
  .openapi("FinalizedStudentResult");

export const finalizationDetailSchema = z
  .object({ finalization: finalizationSchema, results: z.array(storedStudentResultSchema) })
  .openapi("ResultFinalizationDetail");

export const correctionBodySchema = z
  .object({
    reason: z.string().trim().min(5).max(2000),
    marks: z
      .array(
        z
          .object({
            assessment_id: uuidSchema,
            student_id: uuidSchema,
            attempt: z.union([z.literal(1), z.literal(2)]).default(1),
            status: z.enum(["graded", "absent", "excused", "not_applicable", "pending"]),
            score: z.number().min(0).nullable().default(null),
          })
          .openapi("GradingCorrectionBodyMark"),
      )
      .max(500)
      .default([]),
    allow_incomplete: z.boolean().default(false),
  })
  .openapi("CorrectResultsBody");

export const studentResultsSchema = z
  .object({
    results: z.array(
      z
        .object({
          finalization_id: uuidSchema,
          academic_year_id: uuidSchema,
          academic_year_name: z.string(),
          section_name: z.string(),
          grade_level_name: z.string(),
          term_id: uuidSchema.nullable(),
          term_name: z.string().nullable(),
          version: z.number().int(),
          finalized_at: dateTimeSchema,
          result: storedStudentResultSchema,
        })
        .openapi("GradingStudentResultsResult"),
    ),
  })
  .openapi("StudentFinalizedResults");

export const studentReleasedMarksSchema = z
  .object({
    periods: z.array(
      z
        .object({
          academic_year_id: uuidSchema,
          academic_year_name: z.string(),
          term_id: uuidSchema.nullable().openapi({ description: "Null: the annual period." }),
          term_name: z.string().nullable(),
          subjects: z.array(
            z
              .object({
                subject_id: uuidSchema,
                subject_code: z.string(),
                subject_name: z.string(),
                approved_at: dateTimeSchema.nullable(),
                categories: z.array(
                  z
                    .object({
                      category_id: uuidSchema,
                      name: z.string(),
                      kind: z.string(),
                      assessments: z.array(
                        z
                          .object({
                            assessment_id: uuidSchema,
                            name: z.string(),
                            max_marks: z.number(),
                            assessment_date: z.string().nullable(),
                            attempts: z.array(
                              z
                                .object({
                                  attempt: z.number().int(),
                                  status: markStatusSchema,
                                  score: z.number().nullable(),
                                })
                                .openapi("ReleasedMarkAttempt"),
                            ),
                          })
                          .openapi("ReleasedAssessment"),
                      ),
                    })
                    .openapi("ReleasedMarkCategory"),
                ),
              })
              .openapi("ReleasedMarkSubject"),
          ),
        })
        .openapi("ReleasedMarkPeriod"),
    ),
  })
  .openapi("StudentReleasedMarks");

// ---------------------------------------------------------------------------
// Exam structure (School Settings exam system)
// ---------------------------------------------------------------------------

export const examStructureSchema = z
  .enum(["midterm", "periods"])
  .openapi({ description: "midterm: midterm + final; periods: first + second period + final." });

export const examWeightsSchema = z
  .object({
    first_period: z.number().min(0).max(100).optional(),
    second_period: z.number().min(0).max(100).optional(),
    midterm: z.number().min(0).max(100).optional(),
    final_exam: z.number().min(0).max(100).optional(),
    quiz: z.number().min(0).max(100).optional(),
    homework: z.number().min(0).max(100).optional(),
  })
  .strict()
  .openapi("ExamWeights", { description: "Share of a term per part; totals 100." });

export const examTemplateSchema = z
  .object({
    structure: examStructureSchema,
    weights: examWeightsSchema,
    term_weights: z.array(
      z.object({ term_id: uuidSchema, weight: z.number() }).openapi("ExamTemplateTermWeight"),
    ),
    categories: z.array(
      z
        .object({
          ref: z.string(),
          name: z.string(),
          kind: categoryKindSchema,
          scope: categoryScopeSchema,
          weight: z.number().nullable(),
          aggregation: aggregationSchema,
          drop_lowest: z.number().int(),
          sort_order: z.number().int(),
        })
        .openapi("ExamTemplateCategory"),
    ),
    assessments: z.array(
      z
        .object({
          category_ref: z.string(),
          term_id: uuidSchema.nullable(),
          name: z.string(),
          max_marks: z.number(),
          weight: z.number(),
          is_mandatory: z.boolean(),
          assessment_date: z.string().nullable(),
          due_date: z.string().nullable(),
          sort_order: z.number().int(),
        })
        .openapi("ExamTemplateAssessment"),
    ),
  })
  .openapi("ExamTemplate");

const appliedConfigSchema = z.object({
  config_id: uuidSchema,
  subject_name: z.string(),
  section_id: uuidSchema.nullable(),
});

export const applyExamStructureResultSchema = z
  .object({
    academic_year_id: uuidSchema,
    academic_year_name: z.string(),
    structure: examStructureSchema,
    updated: z.array(appliedConfigSchema.openapi("ExamStructureAppliedConfig")),
    skipped: z.array(
      appliedConfigSchema
        .extend({
          reason: z.enum(["has_marks", "section_assessments", "excluded", "invalid"]),
          detail: z.string().nullable(),
        })
        .openapi("ExamStructureSkippedConfig"),
    ),
  })
  .openapi("ApplyExamStructureResult");

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

export const readinessSchema = z
  .object({
    students: z.array(
      z
        .object({
          student_id: uuidSchema,
          first_name: z.string(),
          last_name: z.string(),
          state: z.enum(["ready", "issued", "needs_reissue", "blocked"]),
          reasons: z.array(z.string()),
          certificate_id: uuidSchema.nullable(),
        })
        .openapi("ReadinessStudent"),
    ),
  })
  .openapi("CertificateReadiness");

export const issueCertificatesBodySchema = z
  .object({ student_ids: z.array(uuidSchema).min(1).max(500).optional() })
  .openapi("IssueCertificatesBody");

export const issueCertificatesResultSchema = z
  .object({
    issued: z.array(uuidSchema),
    skipped: readinessSchema.shape.students,
  })
  .openapi("IssueCertificatesResult");

export const certificateContentSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["annual_certificate", "term_report"]),
    serial_number: z.string(),
    issued_at: dateTimeSchema,
    school: z.object({ id: uuidSchema, name: z.string() }).openapi("CertificateContentSchool"),
    academic_year: z
      .object({ id: uuidSchema, code: z.string(), name: z.string() })
      .openapi("CertificateContentAcademicYear"),
    term: z
      .object({ id: uuidSchema, name: z.string() })
      .openapi("CertificateContentTerm")
      .nullable(),
    student: z
      .object({
        id: uuidSchema,
        first_name: z.string(),
        last_name: z.string(),
        admission_number: z.string(),
      })
      .openapi("CertificateContentStudent"),
    grade_level_name: z.string(),
    section_name: z.string(),
    subjects: z.array(
      z
        .object({
          code: z.string(),
          name: z.string(),
          requirement: z.string(),
          marks_obtained: z.number().nullable(),
          max_marks: z.number(),
          percentage: z.number().nullable(),
          grade_label: z.string().nullable(),
          passed: z.boolean().nullable(),
          exempt: z.boolean(),
          terms: z.array(
            z
              .object({
                term_id: uuidSchema.nullable(),
                term_name: z.string().nullable(),
                percentage: z.number().nullable(),
              })
              .openapi("CertificateContentSubjectTerm"),
          ),
        })
        .openapi("CertificateContentSubject"),
    ),
    overall: z
      .object({
        average_percentage: z.number().nullable(),
        total_obtained: z.number().nullable(),
        total_max: z.number().nullable(),
        grade_label: z.string().nullable(),
        subjects_failed: z.number().int(),
        academic_status: z.string(),
      })
      .openapi("CertificateContentOverall"),
    finalization: z
      .object({
        id: uuidSchema,
        version: z.number().int(),
        finalized_at: dateTimeSchema,
      })
      .openapi("CertificateContentFinalization"),
    issued_by: z
      .object({ user_id: uuidSchema, name: z.string().nullable() })
      .openapi("CertificateContentIssuedBy"),
    reissue: z
      .object({ supersedes_serial: z.string(), reason: z.string() })
      .openapi("CertificateContentReissue")
      .nullable(),
  })
  .openapi("CertificateContent");

export const certificateSchema = z
  .object({
    id: uuidSchema,
    kind: z.enum(["annual_certificate", "term_report"]),
    serial_number: z.string(),
    status: z.enum(["issued", "superseded", "revoked"]),
    academic_year_id: uuidSchema,
    student_id: uuidSchema,
    finalization_id: uuidSchema,
    issued_at: dateTimeSchema,
    supersedes_id: uuidSchema.nullable(),
    reissue_reason: z.string().nullable(),
    revoked_at: dateTimeSchema.nullable(),
    revoke_reason: z.string().nullable(),
    content_sha256: z.string(),
    needs_reissue: z.boolean(),
    content: certificateContentSchema,
  })
  .openapi("AcademicCertificate");

export const certificateListSchema = z
  .object({ certificates: z.array(certificateSchema) })
  .openapi("AcademicCertificateList");

export const certificateQuerySchema = z
  .object({
    academic_year_id: uuidSchema.optional(),
    student_id: uuidSchema.optional(),
    section_id: uuidSchema.optional(),
    finalization_id: uuidSchema.optional(),
  })
  .openapi("AcademicCertificateQuery");

export const reasonBodySchema = z
  .object({ reason: z.string().trim().min(5).max(2000) })
  .openapi("CertificateReasonBody");
