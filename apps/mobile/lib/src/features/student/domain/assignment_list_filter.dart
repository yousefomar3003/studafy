/// Which slice of the caller's assignments a list screen tab shows.
///
/// `due` and `submitted` are the two derived statuses `Status12` exposes for the calling
/// student (see `AssignmentsClient.listAssignments`'s doc comment) — `due` merges its
/// `upcoming` and `pastDue` values, since a student needs both "not due yet" and "overdue" work
/// in one "still needs action" view. `graded` has no server-side filter to ask for directly: it
/// is `submitted` narrowed client-side to submissions whose grade has been released — see
/// `assignment_list_providers.dart`.
enum AssignmentListFilter { due, submitted, graded }
