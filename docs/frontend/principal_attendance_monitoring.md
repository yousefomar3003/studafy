# Principal attendance monitoring

The principal attendance route (`/portal/principal/attendance`) provides school and class summaries,
trend analytics, a virtualized daily matrix, chronic-absence alerts, student history, corrections,
and asynchronous XLSX/PDF exports.

## Data flow

React Query hooks isolate visual components from their data source. Summary and student groupings use
`GET /api/attendance/reports/summary`; chart points use the trends endpoint. Exports create a job and
poll it until a download is available. Corrections use the audited record correction endpoint and
invalidate all attendance queries after success.

The backend does not yet expose a daily enriched roster, grade/section metadata, or a cross-session
student timeline. Typed asynchronous adapters in `api/attendanceFixtures.ts` temporarily provide
those shapes. They are deliberately outside components so future endpoints can replace them without
changing screen behavior.

## Filters and URLs

`view`, `start`, `end`, `term_id`, `class_id`, `grade`, `section_id`, `status`, `interval`, and
`breaches=1` are serialized into the query string. Existing `?class_id=` heat-map links remain valid.
The chronic threshold is strictly greater than 10% `absent`; excused attendance is not counted.

## Authorization

- `attendance:report:export` controls export actions.
- `attendance:record:correct` controls correction actions.
- `attendance:correction:override` identifies administrators allowed to correct outside the normal
  window. The API remains the authorization boundary and returns any window rejection to the form.

## Accessibility and performance

The shared `DataGrid` virtualizes fixed-height rows while retaining native table semantics and sticky
headers. Status always has a text label in addition to color. Charts include a title, description,
and textual values. Shared modals provide focus trapping, Escape close, accessible names, and focus
restoration. Responsive layouts collapse analytics and summary cards without changing DOM order.
