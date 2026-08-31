import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/auth/auth_providers.dart';
import '../../../student/presentation/material_viewer_screen.dart';
import '../../domain/ask_ai_conversation.dart';

/// A tappable `[n]` reference under an answer. Tapping it resolves the cited material and opens
/// it in [MaterialViewerScreen] at the cited page (a PDF jumps to `pageNumber`; a slide deck or
/// other type without an in-app preview opens at its start).
///
/// The material is fetched on tap, not up front: an answer can carry several citations and most
/// are never opened.
class AskAiCitationChip extends ConsumerStatefulWidget {
  const AskAiCitationChip({required this.citation, super.key});

  final AskAiCitation citation;

  @override
  ConsumerState<AskAiCitationChip> createState() => _AskAiCitationChipState();
}

class _AskAiCitationChipState extends ConsumerState<AskAiCitationChip> {
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
          builder: (_) => MaterialViewerScreen(
            material: material,
            initialPage: widget.citation.pageNumber,
          ),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('askAi.citation.openError'.tr())),
      );
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final citation = widget.citation;
    final label = citation.materialTitle ?? 'askAi.citation.fallback'.tr();
    final page = citation.pageNumber;

    return ActionChip(
      avatar: _opening
          ? const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : CircleAvatar(child: Text('${citation.order}')),
      label: Text(
        page != null ? 'askAi.citation.withPage'.tr(namedArgs: {'title': label, 'page': '$page'}) : label,
        overflow: TextOverflow.ellipsis,
      ),
      onPressed: _opening ? null : _open,
    );
  }
}
