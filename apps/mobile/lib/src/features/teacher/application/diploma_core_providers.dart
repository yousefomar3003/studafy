import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/diploma_core_client.dart';
import '../domain/diploma_core.dart';
import 'predicted_grades_providers.dart';

final diplomaCoreClientProvider = Provider<DiplomaCoreClient>((ref) {
  return DiplomaCoreClient(authenticatedDio(ref));
});

/// A section's IB Diploma core grades.
final diplomaCoreProvider = FutureProvider.autoDispose
    .family<SectionDiplomaCore, String>((ref, sectionId) {
      return ref.watch(diplomaCoreClientProvider).fetch(sectionId);
    });

/// The class's section when its grade uses the IB Diploma total, else null — so the class screen
/// offers core grade entry only to teachers of IB Diploma classes. Null on any failure too.
final classDiplomaSectionProvider = FutureProvider.autoDispose
    .family<String?, String>((ref, classId) async {
      try {
        final target = await ref.watch(
          classGradingTargetProvider(classId).future,
        );
        if (target == null) return null;
        final core = await ref.watch(
          diplomaCoreProvider(target.sectionId).future,
        );
        return core.enabled ? target.sectionId : null;
      } on Object {
        return null;
      }
    });
