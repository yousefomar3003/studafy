import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/status7.dart';
import '../../../core/api/generated/models/term.dart';
import '../../../core/auth/auth_providers.dart';

/// The school's current academic term — active year, active term within it — for
/// [todayTimetableProvider] and [todayGradesProvider] (`today_providers.dart`) to scope their
/// requests to, so neither hard-codes a term id.
///
/// Deliberately not offline-cached like the four data sources it feeds: it costs two cheap list
/// calls, isn't itself one of this screen's required data sources, and a school in steady state
/// always has exactly one active year and term, so caching it would add a fifth
/// [OfflineCachedResource] (`core/offline/offline_cached_resource.dart`) for no real offline
/// benefit. Throws (surfacing as [AsyncError]) if a school has no active year/term — a genuine
/// misconfiguration, not a state to paper over.
final currentTermProvider = FutureProvider<Term>((ref) async {
  final api = ref.watch(apiClientProvider);

  final years = await api.academics.listAcademicYears(status: Status7.active, limit: 1);
  if (years.academicYears.isEmpty) {
    throw StateError('No active academic year for this school.');
  }
  final year = years.academicYears.first;

  final terms = await api.academics.listTerms(
    yearId: year.id,
    status: Status7.active,
    limit: 1,
  );
  if (terms.terms.isEmpty) {
    throw StateError('No active term in academic year ${year.id}.');
  }
  return terms.terms.first;
});
