import { z } from "zod";

/**
 * Display names as translation keys, resolved with `t()` at render time so they follow a runtime
 * language switch. Validation messages in the schemas below are translation keys too: `fieldErrors`
 * returns them as-is and the form translates them where the error renders.
 */
export const STATUS_LABEL_KEYS = {
  applicant: "adminPeople.students.status.applicant",
  enrolled: "adminPeople.students.status.enrolled",
  suspended: "adminPeople.students.status.suspended",
  graduated: "adminPeople.students.status.graduated",
  withdrawn: "adminPeople.students.status.withdrawn",
  archived: "adminPeople.students.status.archived",
} as const;

export type StudentStatus = keyof typeof STATUS_LABEL_KEYS;

export const RELATIONSHIP_LABEL_KEYS = {
  mother: "adminPeople.students.relationship.mother",
  father: "adminPeople.students.relationship.father",
  guardian: "adminPeople.students.relationship.guardian",
  step_parent: "adminPeople.students.relationship.step_parent",
  grandparent: "adminPeople.students.relationship.grandparent",
  sibling: "adminPeople.students.relationship.sibling",
  other: "adminPeople.students.relationship.other",
} as const;

export type GuardianRelationship = keyof typeof RELATIONSHIP_LABEL_KEYS;

const statusEnum = z.enum(Object.keys(STATUS_LABEL_KEYS) as [StudentStatus, ...StudentStatus[]]);
const relationshipEnum = z.enum(
  Object.keys(RELATIONSHIP_LABEL_KEYS) as [GuardianRelationship, ...GuardianRelationship[]],
);

/** Empty string becomes `undefined`, so an untouched optional date/name field is omitted from the request body rather than sent as `""`. */
function optionalTrimmed(max: number, message: string) {
  return z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((value) => (value ? value : undefined));
}

export const createStudentSchema = z.object({
  first_name: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.firstNameRequired")
    .max(200, "adminPeople.validation.maxLength200"),
  last_name: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.lastNameRequired")
    .max(200, "adminPeople.validation.maxLength200"),
  middle_name: optionalTrimmed(200, "adminPeople.validation.maxLength200"),
  preferred_name: optionalTrimmed(200, "adminPeople.validation.maxLength200"),
  email: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.emailRequired")
    .email("adminPeople.validation.emailInvalid"),
  admission_number: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.admissionNumberRequired")
    .max(100, "adminPeople.validation.maxLength100"),
  admission_date: optionalTrimmed(10, "adminPeople.validation.dateInvalid"),
  date_of_birth: optionalTrimmed(10, "adminPeople.validation.dateInvalid"),
  status: statusEnum,
});
export type CreateStudentValues = z.infer<typeof createStudentSchema>;

/**
 * Admission fields are omitted here, not just optional: a session without `student:billing`-gated
 * visibility never receives real admission data from `getStudent` in the first place (the API
 * returns `admission_number: ""` and `admission_date: null` for those roles — see
 * `apps/api/src/modules/users/routes/student-routes.ts`'s `projectStudent`), so a shared schema
 * that included them would let a masked, empty value round-trip back as a real update. The
 * admission fields this form can actually change live in `editAdmissionSchema` below, rendered
 * only when the viewer holds that visibility.
 */
export const editStudentSchema = z.object({
  first_name: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.firstNameRequired")
    .max(200, "adminPeople.validation.maxLength200"),
  last_name: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.lastNameRequired")
    .max(200, "adminPeople.validation.maxLength200"),
  middle_name: optionalTrimmed(200, "adminPeople.validation.maxLength200"),
  preferred_name: optionalTrimmed(200, "adminPeople.validation.maxLength200"),
  date_of_birth: optionalTrimmed(10, "adminPeople.validation.dateInvalid"),
  status: statusEnum,
});
export type EditStudentValues = z.infer<typeof editStudentSchema>;

export const editAdmissionSchema = z.object({
  admission_number: z
    .string()
    .trim()
    .min(1, "adminPeople.validation.admissionNumberRequired")
    .max(100, "adminPeople.validation.maxLength100"),
  admission_date: optionalTrimmed(10, "adminPeople.validation.dateInvalid"),
});
export type EditAdmissionValues = z.infer<typeof editAdmissionSchema>;

export const linkGuardianSchema = z.object({
  parent_user_id: z.string().trim().min(1, "adminPeople.validation.parentRequired"),
  relationship: relationshipEnum,
});
export type LinkGuardianValues = z.infer<typeof linkGuardianSchema>;

/** Maps a `ZodError` to one message per field, keeping only the first issue per path. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !(field in errors)) {
      // eslint-disable-next-line security/detect-object-injection -- `field` comes from this module's own Zod schema issues, and `errors` is a fresh local object
      errors[field] = issue.message;
    }
  }
  return errors;
}
