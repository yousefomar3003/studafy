import { z } from "zod";

export const STATUS_LABELS = {
  applicant: "Applicant",
  enrolled: "Enrolled",
  suspended: "Suspended",
  graduated: "Graduated",
  withdrawn: "Withdrawn",
  archived: "Archived",
} as const;

export type StudentStatus = keyof typeof STATUS_LABELS;

export const RELATIONSHIP_LABELS = {
  mother: "Mother",
  father: "Father",
  guardian: "Guardian",
  step_parent: "Step-parent",
  grandparent: "Grandparent",
  sibling: "Sibling",
  other: "Other",
} as const;

export type GuardianRelationship = keyof typeof RELATIONSHIP_LABELS;

const statusEnum = z.enum(Object.keys(STATUS_LABELS) as [StudentStatus, ...StudentStatus[]]);
const relationshipEnum = z.enum(
  Object.keys(RELATIONSHIP_LABELS) as [GuardianRelationship, ...GuardianRelationship[]],
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
    .min(1, "First name is required")
    .max(200, "Keep it under 200 characters"),
  last_name: z
    .string()
    .trim()
    .min(1, "Last name is required")
    .max(200, "Keep it under 200 characters"),
  middle_name: optionalTrimmed(200, "Keep it under 200 characters"),
  preferred_name: optionalTrimmed(200, "Keep it under 200 characters"),
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email address"),
  admission_number: z
    .string()
    .trim()
    .min(1, "Admission number is required")
    .max(100, "Keep it under 100 characters"),
  admission_date: optionalTrimmed(10, "Enter a valid date"),
  date_of_birth: optionalTrimmed(10, "Enter a valid date"),
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
    .min(1, "First name is required")
    .max(200, "Keep it under 200 characters"),
  last_name: z
    .string()
    .trim()
    .min(1, "Last name is required")
    .max(200, "Keep it under 200 characters"),
  middle_name: optionalTrimmed(200, "Keep it under 200 characters"),
  preferred_name: optionalTrimmed(200, "Keep it under 200 characters"),
  date_of_birth: optionalTrimmed(10, "Enter a valid date"),
  status: statusEnum,
});
export type EditStudentValues = z.infer<typeof editStudentSchema>;

export const editAdmissionSchema = z.object({
  admission_number: z
    .string()
    .trim()
    .min(1, "Admission number is required")
    .max(100, "Keep it under 100 characters"),
  admission_date: optionalTrimmed(10, "Enter a valid date"),
});
export type EditAdmissionValues = z.infer<typeof editAdmissionSchema>;

export const linkGuardianSchema = z.object({
  parent_user_id: z.string().trim().min(1, "Select a parent"),
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
