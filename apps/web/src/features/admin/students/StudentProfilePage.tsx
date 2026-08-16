import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, Input, Select, Tabs, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";

import { LinkGuardianModal } from "./LinkGuardianModal";
import { useUpdateStudent } from "./mutations";
import {
  fetchStudent,
  fetchStudentEnrollmentHistory,
  fetchStudentGuardians,
  studentEnrollmentHistoryQueryKey,
  studentGuardiansQueryKey,
  studentQueryKey,
} from "./queries";
import {
  editAdmissionSchema,
  editStudentSchema,
  fieldErrors,
  RELATIONSHIP_LABELS,
  STATUS_LABELS,
} from "./schema";
import { UnlinkGuardianDialog } from "./UnlinkGuardianDialog";

import "./students.css";

import type { GuardianContact, StudentProfile } from "./queries";
import type { EditAdmissionValues, EditStudentValues } from "./schema";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const STATUS_OPTIONS: SelectOption<EditStudentValues["status"]>[] = (
  Object.entries(STATUS_LABELS) as [EditStudentValues["status"], string][]
).map(([value, label]) => ({ value, label }));

function fullName(student: StudentProfile): string {
  return [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" ");
}

function demographicsValuesFor(student: StudentProfile): EditStudentValues {
  return {
    first_name: student.first_name,
    last_name: student.last_name,
    middle_name: student.middle_name ?? "",
    preferred_name: student.preferred_name ?? "",
    date_of_birth: student.date_of_birth ?? "",
    status: student.status,
  };
}

function admissionValuesFor(student: StudentProfile): EditAdmissionValues {
  return {
    admission_number: student.admission_number,
    admission_date: student.admission_date ?? "",
  };
}

interface DemographicsSectionProps {
  student: StudentProfile;
  canEdit: boolean;
}

/** View/edit for name, DOB, and status — always visible to anyone who can reach this page (holding
 * `student:read`), edit gated on `student:update`. */
function DemographicsSection({ student, canEdit }: DemographicsSectionProps) {
  const { show } = useToast();
  const updateStudent = useUpdateStudent();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<EditStudentValues>(() => demographicsValuesFor(student));
  const [errors, setErrors] = useState<Partial<Record<keyof EditStudentValues, string>>>({});

  useEffect(() => {
    if (!editing) {
      setValues(demographicsValuesFor(student));
    }
  }, [student, editing]);

  function setField<K extends keyof EditStudentValues>(key: K, value: EditStudentValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function handleCancel() {
    setValues(demographicsValuesFor(student));
    setErrors({});
    setEditing(false);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = editStudentSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    updateStudent.mutate(
      {
        studentId: student.id,
        patch: {
          first_name: result.data.first_name,
          last_name: result.data.last_name,
          middle_name: result.data.middle_name,
          preferred_name: result.data.preferred_name,
          date_of_birth: result.data.date_of_birth,
          status: result.data.status,
        },
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: "Profile updated" });
          setEditing(false);
        },
        onError: (error) => {
          show({
            variant: "error",
            title: "Couldn't save changes",
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
        },
      },
    );
  }

  if (!editing) {
    return (
      <Card as="section" aria-label="Demographics">
        <Card.Header>
          <div className="students-profile__section-header">
            <h2>Demographics</h2>
            {canEdit ? (
              <Button variant="tertiary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
          </div>
        </Card.Header>
        <Card.Body>
          <dl className="students-profile__fields">
            <div>
              <dt>Name</dt>
              <dd>{fullName(student) || "—"}</dd>
            </div>
            <div>
              <dt>Preferred name</dt>
              <dd>{student.preferred_name ?? "—"}</dd>
            </div>
            <div>
              <dt>Date of birth</dt>
              <dd>{student.date_of_birth ?? "—"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className="students-list__status-pill" data-status={student.status}>
                  {STATUS_LABELS[student.status]}
                </span>
              </dd>
            </div>
          </dl>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card as="section" aria-label="Edit demographics">
      <Card.Header>
        <h2>Demographics</h2>
      </Card.Header>
      <form onSubmit={handleSubmit} noValidate aria-label="Edit demographics">
        <Card.Body>
          <Input
            label="First name"
            value={values.first_name}
            onChange={(e) => setField("first_name", e.target.value)}
            error={errors.first_name}
            required
          />
          <Input
            label="Middle name"
            value={values.middle_name}
            onChange={(e) => setField("middle_name", e.target.value)}
            error={errors.middle_name}
          />
          <Input
            label="Last name"
            value={values.last_name}
            onChange={(e) => setField("last_name", e.target.value)}
            error={errors.last_name}
            required
          />
          <Input
            label="Preferred name"
            value={values.preferred_name}
            onChange={(e) => setField("preferred_name", e.target.value)}
            error={errors.preferred_name}
          />
          <Input
            label="Date of birth"
            type="date"
            value={values.date_of_birth}
            onChange={(e) => setField("date_of_birth", e.target.value)}
            error={errors.date_of_birth}
          />
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={values.status}
            onChange={(value) => setField("status", value)}
            required
          />
        </Card.Body>
        <Card.Footer>
          <Button type="button" variant="tertiary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={updateStudent.isPending}>
            Save changes
          </Button>
        </Card.Footer>
      </form>
    </Card>
  );
}

interface AdmissionSectionProps {
  student: StudentProfile;
  canEdit: boolean;
}

/**
 * Admission number/date, shown only to sessions holding `billing:read` — `getStudent` itself masks
 * these fields server-side for everyone else (returns `admission_number: ""`, `admission_date: null`;
 * see `projectStudent` in `apps/api/src/modules/users/routes/student-routes.ts`), so a viewer without
 * that permission never has real data here to hide. This section renders nothing at all rather than
 * an empty/placeholder block for them — there is nothing true to say about a field the API withheld.
 */
function AdmissionSection({ student, canEdit }: AdmissionSectionProps) {
  const { show } = useToast();
  const updateStudent = useUpdateStudent();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<EditAdmissionValues>(() => admissionValuesFor(student));
  const [errors, setErrors] = useState<Partial<Record<keyof EditAdmissionValues, string>>>({});

  useEffect(() => {
    if (!editing) {
      setValues(admissionValuesFor(student));
    }
  }, [student, editing]);

  function setField<K extends keyof EditAdmissionValues>(key: K, value: EditAdmissionValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function handleCancel() {
    setValues(admissionValuesFor(student));
    setErrors({});
    setEditing(false);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = editAdmissionSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    updateStudent.mutate(
      { studentId: student.id, patch: result.data },
      {
        onSuccess: () => {
          show({ variant: "success", title: "Admission info updated" });
          setEditing(false);
        },
        onError: (error) => {
          show({
            variant: "error",
            title: "Couldn't save changes",
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
        },
      },
    );
  }

  if (!editing) {
    return (
      <Card as="section" aria-label="Admission">
        <Card.Header>
          <div className="students-profile__section-header">
            <h2>Admission</h2>
            {canEdit ? (
              <Button variant="tertiary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
          </div>
        </Card.Header>
        <Card.Body>
          <dl className="students-profile__fields">
            <div>
              <dt>Admission number</dt>
              <dd>{student.admission_number || "—"}</dd>
            </div>
            <div>
              <dt>Admission date</dt>
              <dd>{student.admission_date ?? "—"}</dd>
            </div>
          </dl>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card as="section" aria-label="Edit admission">
      <Card.Header>
        <h2>Admission</h2>
      </Card.Header>
      <form onSubmit={handleSubmit} noValidate aria-label="Edit admission">
        <Card.Body>
          <Input
            label="Admission number"
            value={values.admission_number}
            onChange={(e) => setField("admission_number", e.target.value)}
            error={errors.admission_number}
            required
          />
          <Input
            label="Admission date"
            type="date"
            value={values.admission_date}
            onChange={(e) => setField("admission_date", e.target.value)}
            error={errors.admission_date}
          />
        </Card.Body>
        <Card.Footer>
          <Button type="button" variant="tertiary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={updateStudent.isPending}>
            Save changes
          </Button>
        </Card.Footer>
      </form>
    </Card>
  );
}

interface GuardiansTabProps {
  studentId: string;
  canManage: boolean;
}

function GuardiansTab({ studentId, canManage }: GuardiansTabProps) {
  const guardiansQuery = useQuery({
    queryKey: studentGuardiansQueryKey(studentId),
    queryFn: () => fetchStudentGuardians(studentId),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [removingGuardian, setRemovingGuardian] = useState<GuardianContact | null>(null);

  return (
    <>
      <div className="students-profile__section-header">
        <h2>Guardians</h2>
        {canManage ? <Button onClick={() => setLinkOpen(true)}>Add guardian</Button> : null}
      </div>

      {guardiansQuery.isPending ? (
        <p role="status">Loading…</p>
      ) : guardiansQuery.isError ? (
        <p role="alert">Unable to load guardians.</p>
      ) : guardiansQuery.data.length === 0 ? (
        <p>No guardians linked yet.</p>
      ) : (
        <ul className="students-detail-list">
          {guardiansQuery.data.map((guardian) => (
            <li key={guardian.parent_user_id} className="students-detail-list__item">
              <div>
                <p>
                  {guardian.user?.display_name ?? guardian.user?.email ?? guardian.parent_user_id}
                </p>
                <p className="students-detail-list__meta">
                  {guardian.user?.email ?? "Account unavailable"} &middot;{" "}
                  {RELATIONSHIP_LABELS[guardian.relationship]}
                </p>
              </div>
              {canManage ? (
                <Button variant="tertiary" onClick={() => setRemovingGuardian(guardian)}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <LinkGuardianModal studentId={studentId} open={linkOpen} onClose={() => setLinkOpen(false)} />
      <UnlinkGuardianDialog
        studentId={studentId}
        guardian={removingGuardian}
        onClose={() => setRemovingGuardian(null)}
      />
    </>
  );
}

function EnrollmentHistoryTab({ studentId }: { studentId: string }) {
  const historyQuery = useQuery({
    queryKey: studentEnrollmentHistoryQueryKey(studentId),
    queryFn: () => fetchStudentEnrollmentHistory(studentId),
  });

  return (
    <>
      <h2>Enrollment history</h2>
      {historyQuery.isPending ? (
        <p role="status">Loading…</p>
      ) : historyQuery.isError ? (
        <p role="alert">Unable to load enrollment history.</p>
      ) : historyQuery.data.length === 0 ? (
        <p>No enrollment history yet.</p>
      ) : (
        <ul className="students-detail-list">
          {historyQuery.data.map((entry) => (
            <li
              key={`${entry.class_id}-${entry.enrolled_at}`}
              className="students-detail-list__item"
            >
              <div>
                <p>{entry.class?.code ?? entry.class_id}</p>
                <p className="students-detail-list__meta">
                  {entry.status} &middot; enrolled{" "}
                  {new Date(entry.enrolled_at).toLocaleDateString()}
                  {entry.withdrawn_at
                    ? ` · withdrawn ${new Date(entry.withdrawn_at).toLocaleDateString()}`
                    : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Student profile (`/portal/admin/students/:studentId`), gated by `organization:manageSettings` like
 * the rest of `/portal/admin`. Field- and action-level visibility within the page follows the
 * session's actual permission set rather than the blanket route gate: `billing:read` for admission
 * data (mirrors the server's own `projectStudent` masking) and `student:update` for every mutation
 * (edit, guardian add/remove) — both are UX only, not the authorization boundary; the API re-checks
 * independently (see `RequirePermission`'s doc for the same caveat).
 */
export default function StudentProfilePage() {
  const { studentId } = useParams<{ studentId: string }>();
  const permissions = usePermissions();
  const canViewAdmissionData = permissions.has(PERMISSIONS.BILLING_READ);
  const canEdit = permissions.has(PERMISSIONS.STUDENT_UPDATE);

  const studentQuery = useQuery({
    queryKey: studentQueryKey(studentId!),
    queryFn: () => fetchStudent(studentId!),
    enabled: Boolean(studentId),
  });

  if (!studentId) {
    return <p role="alert">No student selected.</p>;
  }

  if (studentQuery.isPending) {
    return <p role="status">Loading…</p>;
  }

  if (studentQuery.isError || !studentQuery.data) {
    return <p role="alert">Unable to load this student.</p>;
  }

  const student = studentQuery.data;

  return (
    <>
      <p className="students-profile__back">
        <Link to="/portal/admin/students">&larr; Back to students</Link>
      </p>
      <h1>{fullName(student) || "Student"}</h1>

      <Tabs defaultValue="profile">
        <Tabs.List>
          <Tabs.Tab value="profile">Profile</Tabs.Tab>
          <Tabs.Tab value="guardians">Guardians</Tabs.Tab>
          <Tabs.Tab value="enrollment">Enrollment history</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="profile">
          <div className="students-profile__sections">
            <DemographicsSection student={student} canEdit={canEdit} />
            {canViewAdmissionData ? <AdmissionSection student={student} canEdit={canEdit} /> : null}
          </div>
        </Tabs.Panel>

        <Tabs.Panel value="guardians">
          <GuardiansTab studentId={student.id} canManage={canEdit} />
        </Tabs.Panel>

        <Tabs.Panel value="enrollment">
          <EnrollmentHistoryTab studentId={student.id} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
