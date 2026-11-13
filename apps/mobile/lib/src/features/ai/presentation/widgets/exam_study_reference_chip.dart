import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/auth/auth_providers.dart';
import '../../../student/presentation/material_viewer_screen.dart';
import '../../domain/exam.dart';

/// A tappable source reference under a weak topic in the exam report — "report links open
/// materials". Mirrors `QuizCitationChip`'s open-on-tap behavior (fetch the material on tap,
/// open [MaterialViewerScreen] at the cited page); duplicated rather than shared for the same
/// reason that chip's own doc comment gives.
///
/// Takes [materialId] / [materialTitle] separately from [reference] because
/// [ExamStudyReference] itself only carries the chunk-level fields (`exam/report.ts` groups
/// references under a topic that already knows the material) — this chip is what recombines the
/// two for a single tap target.
class ExamStudyReferenceChip extends ConsumerStatefulWidget {
  const ExamStudyReferenceChip({
    required this.materialId,
    required this.materialTitle,
    required this.reference,
    super.key,
  });

  final String materialId;
  final String? materialTitle;
  final ExamStudyReference reference;

  @override
  ConsumerState<ExamStudyReferenceChip> createState() => _ExamStudyReferenceChipState();
}

class _ExamStudyReferenceChipState extends ConsumerState<ExamStudyReferenceChip> {
  bool _opening = false;

  Future<void> _open() async {
    setState(() => _opening = true);
    try {
      final material = await ref
          .read(apiClientProvider)
          .academics
          .getMaterial(materialId: widget.materialId);
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              MaterialViewerScreen(material: material, initialPage: widget.reference.pageNumber),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('examMode.citation.openError'.tr())));
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final label = widget.materialTitle ?? 'examMode.citation.fallback'.tr();
    final page = widget.reference.pageNumber;

    return ActionChip(
      avatar: _opening
          ? const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.menu_book_outlined, size: 16),
      label: Text(
        page != null ? 'examMode.citation.withPage'.tr(namedArgs: {'title': label, 'page': '$page'}) : label,
        overflow: TextOverflow.ellipsis,
      ),
      onPressed: _opening ? null : _open,
    );
  }
}
