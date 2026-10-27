import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/mark_sheet_client.dart';
import '../domain/mark_sheet.dart';

/// [MarkSheetClient] on its own [Dio] ([authenticatedDio]: wired exactly like the generated
/// client's), the `gradeEntryClientProvider` pattern.
final markSheetClientProvider = Provider<MarkSheetClient>((ref) {
  return MarkSheetClient(authenticatedDio(ref));
});

/// The sections and subjects the signed-in teacher grades this year, with each period's
/// mark-sheet status. Pull-to-refresh invalidates it; so does returning from a mark sheet.
final myGradingAssignmentsProvider =
    FutureProvider.autoDispose<List<GradingAssignment>>((ref) {
      return ref.watch(markSheetClientProvider).listMyAssignments();
    });

/// Identifies one mark sheet: a section and one of its subjects.
typedef MarkSheetKey = ({String sectionId, String subjectId});

/// One section + subject's mark sheet. A notifier rather than a plain future so a save — whose
/// response carries the whole refreshed sheet — can [MarkSheetNotifier.replace] the state without
/// a second round trip.
final markSheetProvider = AsyncNotifierProvider.autoDispose
    .family<MarkSheetNotifier, MarkSheet, MarkSheetKey>(MarkSheetNotifier.new);

class MarkSheetNotifier extends AsyncNotifier<MarkSheet> {
  MarkSheetNotifier(this.key);

  final MarkSheetKey key;

  @override
  Future<MarkSheet> build() => ref
      .watch(markSheetClientProvider)
      .fetchMarkSheet(key.sectionId, key.subjectId);

  /// Adopt a sheet the server returned from a write.
  void replace(MarkSheet sheet) => state = AsyncData(sheet);

  /// Write [entries] and adopt the refreshed sheet. Throws the API's `DioException` on failure,
  /// leaving the current state untouched.
  Future<MarkSheet> save(List<MarkEntryInput> entries) async {
    final sheet = await ref
        .read(markSheetClientProvider)
        .saveMarks(key.sectionId, key.subjectId, entries);
    replace(sheet);
    return sheet;
  }

  /// Re-read from the server (after a submit, an added assessment or a conflict).
  Future<void> reload() async {
    final sheet = await ref
        .read(markSheetClientProvider)
        .fetchMarkSheet(key.sectionId, key.subjectId);
    replace(sheet);
  }
}
