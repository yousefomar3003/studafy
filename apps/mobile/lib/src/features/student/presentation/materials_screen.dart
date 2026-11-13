import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/materials_providers.dart';
import '../application/student_context_providers.dart';
import 'widgets/class_materials_section.dart';
import 'widgets/materials_placeholders.dart';

/// The student's materials library: one section per enrolled class, each independently loaded
/// and offline-cached (see `materialsForClassProvider`).
///
/// Empty when [currentEnrolledClassIdsProvider] is unresolved — the same honest "not available
/// yet" state the timetable and attendance screens show for the same reason (there is no
/// self-scoped enrollments endpoint yet); see that provider's doc comment.
///
/// [focusClassId] narrows the library to a single class — the entry point from an exam's "study
/// materials" link, where the class is already known and doesn't depend on the enrolment seam.
/// Null (the default) shows every enrolled class.
class MaterialsScreen extends ConsumerWidget {
  const MaterialsScreen({this.focusClassId, super.key});

  final String? focusClassId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final focusId = focusClassId;
    final classIds = focusId != null
        ? [focusId]
        : ref.watch(currentEnrolledClassIdsProvider);

    return Scaffold(
      appBar: AppBar(title: Text('materials.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () async {
          for (final classId in classIds) {
            ref.invalidate(materialsForClassProvider(classId));
          }
        },
        child: classIds.isEmpty
            ? const MaterialsMessage(messageKey: 'materials.unavailable', icon: Icons.info_outline)
            : ListView.separated(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(AppSpacing.space16),
                itemCount: classIds.length,
                separatorBuilder: (context, index) => const SizedBox(height: AppSpacing.space24),
                itemBuilder: (context, index) => ClassMaterialsSection(classId: classIds[index]),
              ),
      ),
    );
  }
}
