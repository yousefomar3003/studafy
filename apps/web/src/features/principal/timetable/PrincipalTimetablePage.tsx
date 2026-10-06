import { Select } from "@studafy/ui";
import { useState } from "react";

import { Loading } from "../../../components/Loading";
import { useTranslation } from "../../../lib/i18n";
import { TimetableGrid } from "../../admin/timetable/TimetableGrid";
import {
  useApprovedTimetable,
  useClassesForTerm,
  useRooms,
  useTeacherContacts,
} from "../school/queries";
import { TermPicker, useTermSelection } from "../school/TermPicker";

import "../../admin/timetable/timetable.css";
import "../school/principal-school.css";

const ALL = "all";

/**
 * Timetable (`/portal/principal/timetable`): the term's approved weekly timetable — what is
 * actually running — read-only, narrowed to one class or one teacher on demand. Built on the admin
 * timetable builder's grid in read-only mode; drafting and approving versions stay with the admin
 * builder and the approvals queue.
 */
export default function PrincipalTimetablePage() {
  const { t } = useTranslation();
  const selection = useTermSelection();
  const timetable = useApprovedTimetable(selection.term?.id);
  const classes = useClassesForTerm(selection.term?.id);
  const teachers = useTeacherContacts();
  const rooms = useRooms();
  const [classFilter, setClassFilter] = useState(ALL);
  const [teacherFilter, setTeacherFilter] = useState(ALL);

  const classList = [...(classes.data ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const teacherList = [...(teachers.data ?? [])].sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  );
  const slots = (timetable.data?.slots ?? []).filter(
    (slot) =>
      (classFilter === ALL || slot.class_id === classFilter) &&
      (teacherFilter === ALL || slot.teacher_id === teacherFilter),
  );

  const loading =
    selection.isPending ||
    timetable.isPending ||
    classes.isPending ||
    teachers.isPending ||
    rooms.isPending;
  const version = timetable.data?.version;

  return (
    <>
      <h1>{t("principal.timetable.title")}</h1>
      <p>{t("principal.timetable.description")}</p>

      <div className="principal-school__filters">
        <TermPicker selection={selection} />
        <Select
          label={t("principal.school.classLabel")}
          options={[
            { value: ALL, label: t("principal.timetable.allClasses") },
            ...classList.map((klass) => ({ value: klass.id, label: klass.code })),
          ]}
          value={classFilter}
          onChange={setClassFilter}
        />
        <Select
          label={t("principal.timetable.teacherLabel")}
          options={[
            { value: ALL, label: t("principal.timetable.allTeachers") },
            ...teacherList.map((teacher) => ({ value: teacher.id, label: teacher.display_name })),
          ]}
          value={teacherFilter}
          onChange={setTeacherFilter}
        />
      </div>

      {loading ? (
        <Loading />
      ) : timetable.isError ? (
        <p role="alert">{t("principal.timetable.error")}</p>
      ) : !version ? (
        <p className="principal-school__empty">{t("principal.timetable.noApproved")}</p>
      ) : (
        <TimetableGrid
          version={version}
          slots={slots}
          classes={classList}
          teachers={teacherList}
          rooms={rooms.data ?? []}
          isReadOnly
        />
      )}
    </>
  );
}
