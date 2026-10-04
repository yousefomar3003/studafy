import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, Input, Select, Tabs, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";

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
  RELATIONSHIP_LABEL_KEYS,
  STATUS_LABEL_KEYS,
} from "./schema";
import { UnlinkGuardianDialog } from "./UnlinkGuardianDialog";

import "./students.css";

import type { GuardianContact, StudentProfile } from "./queries";
import type { EditAdmissionValues, EditStudentValues } from "./schema";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

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
  const { t } = useTranslation();
  const { show } = useToast();
  const updateStudent = useUpdateStudent();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<EditStudentValues>(() => demographicsValuesFor(student));
  const [errors, setErrors] = useState<Partial<Record<keyof EditStudentValues, string>>>({});

  const statusOptions: SelectOption<EditStudentValues["status"]>[] = (
    Object.entries(STATUS_LABEL_KEYS) as [EditStudentValues["status"], string][]
  ).map(([value, key]) => ({ value, label: t(key) }));

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
          show({
            variant: "success",
            title: t("adminPeople.students.profile.profileUpdatedToast"),
          });
          setEditing(false);
        },
        onError: (error) => {
          show({
            variant: "error",
            title: t("adminPeople.students.profile.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
        },
      },
    );
  }

  if (!editing) {
    return (
      <Card as="section" aria-label={t("adminPeople.students.profile.demographics")}>
        <Card.Header>
          <div className="students-profile__section-header">
            <h2>{t("adminPeople.students.profile.demographics")}</h2>
            {canEdit ? (
              <Button variant="tertiary" onClick={() => setEditing(true)}>
                {t("adminPeople.students.profile.edit")}
              </Button>
            ) : null}
          </div>
        </Card.Header>
        <Card.Body>
          <dl className="students-profile__fields">
            <div>
              <dt>{t("adminPeople.students.profile.name")}</dt>
              <dd>{fullName(student) || "—"}</dd>
            </div>
            <div>
              <dt>{t("adminPeople.students.form.preferredName")}</dt>
              <dd>{student.preferred_name ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("adminPeople.students.form.dateOfBirth")}</dt>
              <dd>{student.date_of_birth ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("adminPeople.students.form.status")}</dt>
              <dd>
                <span className="students-list__status-pill" data-status={student.status}>
                  {t(STATUS_LABEL_KEYS[student.status])}
                </span>
              </dd>
            </div>
          </dl>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card as="section" aria-label={t("adminPeople.students.profile.editDemographics")}>
      <Card.Header>
        <h2>{t("adminPeople.students.profile.demographics")}</h2>
      </Card.Header>
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label={t("adminPeople.students.profile.editDemographics")}
      >
        <Card.Body>
          <Input
            label={t("adminPeople.students.form.firstName")}
            value={values.first_name}
            onChange={(e) => setField("first_name", e.target.value)}
            error={errors.first_name && t(errors.first_name)}
            required
          />
          <Input
            label={t("adminPeople.students.form.middleName")}
            value={values.middle_name}
            onChange={(e) => setField("middle_name", e.target.value)}
            error={errors.middle_name && t(errors.middle_name)}
          />
          <Input
            label={t("adminPeople.students.form.lastName")}
            value={values.last_name}
            onChange={(e) => setField("last_name", e.target.value)}
            error={errors.last_name && t(errors.last_name)}
            required
          />
          <Input
            label={t("adminPeople.students.form.preferredName")}
            value={values.preferred_name}
            onChange={(e) => setField("preferred_name", e.target.value)}
            error={errors.preferred_name && t(errors.preferred_name)}
          />
          <Input
            label={t("adminPeople.students.form.dateOfBirth")}
            type="date"
            value={values.date_of_birth}
            onChange={(e) => setField("date_of_birth", e.target.value)}
            error={errors.date_of_birth && t(errors.date_of_birth)}
          />
          <Select
            label={t("adminPeople.students.form.status")}
            options={statusOptions}
            value={values.status}
            onChange={(value) => setField("status", value)}
            required
          />
        </Card.Body>
        <Card.Footer>
          <Button type="button" variant="tertiary" onClick={handleCancel}>
            {t("adminPeople.common.cancel")}
          </Button>
          <Button type="submit" loading={updateStudent.isPending}>
            {t("adminPeople.common.saveChanges")}
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
  const { t } = useTranslation();
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
          show({
            variant: "success",
            title: t("adminPeople.students.profile.admissionUpdatedToast"),
          });
          setEditing(false);
        },
        onError: (error) => {
          show({
            variant: "error",
            title: t("adminPeople.students.profile.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
        },
      },
    );
  }

  if (!editing) {
    return (
      <Card as="section" aria-label={t("adminPeople.students.profile.admission")}>
        <Card.Header>
          <div className="students-profile__section-header">
            <h2>{t("adminPeople.students.profile.admission")}</h2>
            {canEdit ? (
              <Button variant="tertiary" onClick={() => setEditing(true)}>
                {t("adminPeople.students.profile.edit")}
              </Button>
            ) : null}
          </div>
        </Card.Header>
        <Card.Body>
          <dl className="students-profile__fields">
            <div>
              <dt>{t("adminPeople.students.form.admissionNumber")}</dt>
              <dd>{student.admission_number || "—"}</dd>
            </div>
            <div>
              <dt>{t("adminPeople.students.form.admissionDate")}</dt>
              <dd>{student.admission_date ?? "—"}</dd>
            </div>
          </dl>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card as="section" aria-label={t("adminPeople.students.profile.editAdmission")}>
      <Card.Header>
        <h2>{t("adminPeople.students.profile.admission")}</h2>
      </Card.Header>
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label={t("adminPeople.students.profile.editAdmission")}
      >
        <Card.Body>
          <Input
            label={t("adminPeople.students.form.admissionNumber")}
            value={values.admission_number}
            onChange={(e) => setField("admission_number", e.target.value)}
            error={errors.admission_number && t(errors.admission_number)}
            required
          />
          <Input
            label={t("adminPeople.students.form.admissionDate")}
            type="date"
            value={values.admission_date}
            onChange={(e) => setField("admission_date", e.target.value)}
            error={errors.admission_date && t(errors.admission_date)}
          />
        </Card.Body>
        <Card.Footer>
          <Button type="button" variant="tertiary" onClick={handleCancel}>
            {t("adminPeople.common.cancel")}
          </Button>
          <Button type="submit" loading={updateStudent.isPending}>
            {t("adminPeople.common.saveChanges")}
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
  const { t } = useTranslation();
  const guardiansQuery = useQuery({
    queryKey: studentGuardiansQueryKey(studentId),
    queryFn: () => fetchStudentGuardians(studentId),
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [removingGuardian, setRemovingGuardian] = useState<GuardianContact | null>(null);

  return (
    <>
      <div className="students-profile__section-header">
        <h2>{t("adminPeople.students.profile.guardians")}</h2>
        {canManage ? (
          <Button onClick={() => setLinkOpen(true)}>
            {t("adminPeople.students.profile.addGuardian")}
          </Button>
        ) : null}
      </div>

      {guardiansQuery.isPending ? (
        <p role="status">{t("adminPeople.common.loading")}</p>
      ) : guardiansQuery.isError ? (
        <p role="alert">{t("adminPeople.students.profile.guardiansLoadError")}</p>
      ) : guardiansQuery.data.length === 0 ? (
        <p>{t("adminPeople.students.profile.noGuardians")}</p>
      ) : (
        <ul className="students-detail-list">
          {guardiansQuery.data.map((guardian) => (
            <li key={guardian.parent_user_id} className="students-detail-list__item">
              <div>
                <p>
                  {guardian.user?.display_name ?? guardian.user?.email ?? guardian.parent_user_id}
                </p>
                <p className="students-detail-list__meta">
                  {guardian.user?.email ?? t("adminPeople.students.profile.accountUnavailable")}{" "}
                  &middot; {t(RELATIONSHIP_LABEL_KEYS[guardian.relationship])}
                </p>
              </div>
              {canManage ? (
                <Button variant="tertiary" onClick={() => setRemovingGuardian(guardian)}>
                  {t("adminPeople.students.profile.removeGuardian")}
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
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const historyQuery = useQuery({
    queryKey: studentEnrollmentHistoryQueryKey(studentId),
    queryFn: () => fetchStudentEnrollmentHistory(studentId),
  });

  return (
    <>
      <h2>{t("adminPeople.students.profile.enrollmentHistory")}</h2>
      {historyQuery.isPending ? (
        <p role="status">{t("adminPeople.common.loading")}</p>
      ) : historyQuery.isError ? (
        <p role="alert">{t("adminPeople.students.profile.enrollmentLoadError")}</p>
      ) : historyQuery.data.length === 0 ? (
        <p>{t("adminPeople.students.profile.noEnrollment")}</p>
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
                  {entry.withdrawn_at
                    ? t("adminPeople.students.profile.enrollmentMetaWithdrawn", {
                        status: t(`adminPeople.students.profile.enrollmentStatus.${entry.status}`),
                        enrolled: formatDate(new Date(entry.enrolled_at)),
                        withdrawn: formatDate(new Date(entry.withdrawn_at)),
                      })
                    : t("adminPeople.students.profile.enrollmentMeta", {
                        status: t(`adminPeople.students.profile.enrollmentStatus.${entry.status}`),
                        enrolled: formatDate(new Date(entry.enrolled_at)),
                      })}
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
  const { t } = useTranslation();
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
    return <p role="alert">{t("adminPeople.students.profile.noStudent")}</p>;
  }

  if (studentQuery.isPending) {
    return <p role="status">{t("adminPeople.common.loading")}</p>;
  }

  if (studentQuery.isError || !studentQuery.data) {
    return <p role="alert">{t("adminPeople.students.profile.loadError")}</p>;
  }

  const student = studentQuery.data;

  return (
    <>
      <p className="students-profile__back">
        <Link to="/portal/admin/students">{t("adminPeople.students.backToStudents")}</Link>
      </p>
      <h1>{fullName(student) || t("adminPeople.students.profile.studentFallback")}</h1>

      <Tabs defaultValue="profile">
        <Tabs.List>
          <Tabs.Tab value="profile">{t("adminPeople.students.profile.tabProfile")}</Tabs.Tab>
          <Tabs.Tab value="guardians">{t("adminPeople.students.profile.guardians")}</Tabs.Tab>
          <Tabs.Tab value="enrollment">
            {t("adminPeople.students.profile.enrollmentHistory")}
          </Tabs.Tab>
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
