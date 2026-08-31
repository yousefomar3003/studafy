import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/auth/auth_providers.dart';
import '../../../student/presentation/material_viewer_screen.dart';
import '../../domain/quiz.dart';

/// A tappable source reference under a graded question's feedback — the "citation" half of the
/// player's "instant feedback with explanation + citation" requirement. Mirrors
/// `AskAiCitationChip`'s open-on-tap behavior (fetch the material on tap, open
/// [MaterialViewerScreen] at the cited page); duplicated rather than shared because
/// [QuizCitation] carries no `order` to badge the chip with — a quiz question has exactly one
/// citation, unlike an Ask AI answer's numbered list.
class QuizCitationChip extends ConsumerStatefulWidget {
  const QuizCitationChip({required this.citation, super.key});

  final QuizCitation citation;

  @override
  ConsumerState<QuizCitationChip> createState() => _QuizCitationChipState();
}

class _QuizCitationChipState extends ConsumerState<QuizCitationChip> {
  bool _opening = false;

  Future<void> _open() async {
    setState(() => _opening = true);
    try {
      final material = await ref
          .read(apiClientProvider)
          .academics
          .getMaterial(materialId: widget.citation.materialId);
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              MaterialViewerScreen(material: material, initialPage: widget.citation.pageNumber),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('quiz.citation.openError'.tr())));
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final citation = widget.citation;
    final label = citation.materialTitle ?? 'quiz.citation.fallback'.tr();
    final page = citation.pageNumber;

    return ActionChip(
      avatar: _opening
          ? const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.menu_book_outlined, size: 16),
      label: Text(
        page != null ? 'quiz.citation.withPage'.tr(namedArgs: {'title': label, 'page': '$page'}) : label,
        overflow: TextOverflow.ellipsis,
      ),
      onPressed: _opening ? null : _open,
    );
  }
}
