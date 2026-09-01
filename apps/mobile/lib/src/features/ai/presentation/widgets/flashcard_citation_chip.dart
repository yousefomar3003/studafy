import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/auth/auth_providers.dart';
import '../../../student/presentation/material_viewer_screen.dart';
import '../../domain/flashcard.dart';

/// A tappable source reference under a flashcard's answer face. Mirrors `QuizCitationChip`
/// (open-on-tap: fetch the material, open [MaterialViewerScreen] at the cited page); duplicated
/// rather than shared for the same reason — [FlashcardCitation] is its own domain type, not
/// [QuizCitation].
class FlashcardCitationChip extends ConsumerStatefulWidget {
  const FlashcardCitationChip({required this.citation, super.key});

  final FlashcardCitation citation;

  @override
  ConsumerState<FlashcardCitationChip> createState() => _FlashcardCitationChipState();
}

class _FlashcardCitationChipState extends ConsumerState<FlashcardCitationChip> {
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
      ).showSnackBar(SnackBar(content: Text('flashcards.citation.openError'.tr())));
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final citation = widget.citation;
    final label = citation.materialTitle ?? 'flashcards.citation.fallback'.tr();
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
        page != null
            ? 'flashcards.citation.withPage'.tr(namedArgs: {'title': label, 'page': '$page'})
            : label,
        overflow: TextOverflow.ellipsis,
      ),
      onPressed: _opening ? null : _open,
    );
  }
}
