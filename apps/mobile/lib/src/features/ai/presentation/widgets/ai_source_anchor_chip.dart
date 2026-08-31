import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/auth/auth_providers.dart';
import '../../../student/presentation/material_viewer_screen.dart';
import '../../domain/ai_study.dart';

/// A tappable source anchor under a summary or a key concept. Tapping it fetches the owning
/// material and opens it in [MaterialViewerScreen] at the anchored page (a PDF jumps to
/// `pageNumber`; anything without an in-app preview opens at its start).
///
/// The material is fetched on tap, not up front — a summary can carry many anchors and most are
/// never opened. The owning [materialId] is passed in because the summarize/concepts endpoints are
/// single-material and don't repeat it per anchor.
class AiSourceAnchorChip extends ConsumerStatefulWidget {
  const AiSourceAnchorChip({required this.anchor, required this.materialId, super.key});

  final AiSourceAnchor anchor;
  final String materialId;

  @override
  ConsumerState<AiSourceAnchorChip> createState() => _AiSourceAnchorChipState();
}

class _AiSourceAnchorChipState extends ConsumerState<AiSourceAnchorChip> {
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
          builder: (_) => MaterialViewerScreen(
            material: material,
            initialPage: widget.anchor.pageNumber,
          ),
        ),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('aiStudy.sources.openError'.tr())),
      );
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final anchor = widget.anchor;
    final section = anchor.sectionTitle;
    final page = anchor.pageNumber;
    final label = section != null && section.isNotEmpty
        ? section
        : page != null
        ? 'aiStudy.sources.page'.tr(namedArgs: {'page': '$page'})
        : 'aiStudy.sources.fallback'.tr(namedArgs: {'n': '${anchor.order}'});

    return ActionChip(
      avatar: _opening
          ? const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : CircleAvatar(child: Text('${anchor.order}')),
      label: Text(label, overflow: TextOverflow.ellipsis),
      onPressed: _opening ? null : _open,
    );
  }
}
