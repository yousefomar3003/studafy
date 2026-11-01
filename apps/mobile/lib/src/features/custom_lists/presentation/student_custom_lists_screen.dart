import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/custom_lists_providers.dart';
import 'linked_custom_lists_section.dart';

/// What the school's custom lists hold about one student (a locker, a bus stop, library loans),
/// opened from a class roster. Read-only, sensitive cells masked.
class StudentCustomListsScreen extends ConsumerWidget {
  const StudentCustomListsScreen({
    required this.studentId,
    required this.studentName,
    super.key,
  });

  final String studentId;
  final String studentName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final linked = ref.watch(linkedCustomListsProvider(('student', studentId)));

    return Scaffold(
      appBar: AppBar(title: Text(studentName)),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(
          linkedCustomListsProvider(('student', studentId)).future,
        ),
        child: ListView(
          padding: const EdgeInsets.all(
            AppSpacing.space16,
          ).withBottomInset(context),
          children: [
            linked.when(
              loading: () => const Padding(
                padding: EdgeInsets.all(AppSpacing.space24),
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (_, _) => Column(
                children: [
                  Text(
                    'customLists.linked.loadError'.tr(),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: AppSpacing.space12),
                  OutlinedButton(
                    onPressed: () => ref.invalidate(
                      linkedCustomListsProvider(('student', studentId)),
                    ),
                    child: Text('customLists.retry'.tr()),
                  ),
                ],
              ),
              data: (lists) => lists.isEmpty
                  ? Text(
                      'customLists.linked.empty'.tr(),
                      key: const Key('studentCustomListsEmpty'),
                    )
                  : LinkedCustomListsSection(
                      subjectKind: 'student',
                      subjectId: studentId,
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
