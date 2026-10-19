import { Input } from "@studafy/ui";
import { useDeferredValue, useId, useState } from "react";
import { Link } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";
import { studentDisplayName } from "../principal/school/queries";

import { useStudentSearch } from "./queries";

/**
 * Find a student by name or admission number and open their attendance profile. Results come from
 * `GET /api/students?search=`, so they follow the caller's row scope: a teacher only finds students
 * in classes they teach.
 */
export function StudentSearch() {
  const { t } = useTranslation();
  const resultsId = useId();
  const [term, setTerm] = useState("");
  const deferred = useDeferredValue(term);
  const search = useStudentSearch(deferred);
  const query = deferred.trim();
  const results = search.data ?? [];

  return (
    <div className="attendance-office__search">
      <Input
        type="search"
        label={t("attendanceOffice.search.label")}
        placeholder={t("attendanceOffice.search.placeholder")}
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        aria-controls={resultsId}
      />
      <div id={resultsId} aria-live="polite">
        {query.length < 2 ? null : search.isPending ? (
          <p className="attendance-office__muted">{t("attendanceOffice.search.searching")}</p>
        ) : search.isError ? (
          <p className="attendance-office__muted">{t("attendanceOffice.search.error")}</p>
        ) : results.length === 0 ? (
          <p className="attendance-office__muted">{t("attendanceOffice.search.empty")}</p>
        ) : (
          <ul className="attendance-office__search-results">
            {results.map((student) => (
              <li key={student.id}>
                <Link to={`/portal/attendance/students/${student.id}`}>
                  {studentDisplayName(student)}
                </Link>
                <span className="attendance-office__muted">{student.admission_number}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
