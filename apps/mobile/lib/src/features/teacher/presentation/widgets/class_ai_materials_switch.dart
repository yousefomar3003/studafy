import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../core/api/generated/models/update_class_ai_materials_body.dart';
import '../../../../core/auth/auth_providers.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// The per-class "Use this class's materials with the AI study assistant" switch (000196).
///
/// Reads `GET /api/academics/classes/{classId}/ai-materials` and writes the `PUT` of the same path.
/// Turning it off asks first, because the server deletes the AI copies of the class's materials and
/// everything generated from them. [onChanged] runs after a successful change, so the materials
/// list can refresh the statuses the change moved (turning it on queues materials for ingestion).
class ClassAiMaterialsSwitch extends ConsumerStatefulWidget {
  const ClassAiMaterialsSwitch({
    required this.classId,
    this.onChanged,
    super.key,
  });

  final String classId;
  final VoidCallback? onChanged;

  @override
  ConsumerState<ClassAiMaterialsSwitch> createState() =>
      _ClassAiMaterialsSwitchState();
}

class _ClassAiMaterialsSwitchState
    extends ConsumerState<ClassAiMaterialsSwitch> {
  bool? _enabled;
  bool _loadFailed = false;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final setting = await ref
          .read(apiClientProvider)
          .academics
          .getClassAiMaterials(classId: widget.classId);
      if (!mounted) return;
      setState(() {
        _enabled = setting.enabled;
        _loadFailed = false;
      });
    } on Object {
      if (!mounted) return;
      setState(() => _loadFailed = true);
    }
  }

  Future<bool> _confirmTurnOff() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('teacher.content.aiMaterials.confirmOffTitle'.tr()),
        content: Text('teacher.content.aiMaterials.confirmOffBody'.tr()),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text('teacher.content.aiMaterials.cancel'.tr()),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('teacher.content.aiMaterials.confirmOff'.tr()),
          ),
        ],
      ),
    );
    return confirmed ?? false;
  }

  Future<void> _set(bool enabled) async {
    if (!enabled && !await _confirmTurnOff()) return;
    if (!mounted) return;
    setState(() => _saving = true);
    try {
      final setting = await ref
          .read(apiClientProvider)
          .academics
          .updateClassAiMaterials(
            classId: widget.classId,
            body: UpdateClassAiMaterialsBody(enabled: enabled),
          );
      if (!mounted) return;
      setState(() => _enabled = setting.enabled);
      widget.onChanged?.call();
    } on DioException catch (error) {
      if (!mounted) return;
      final apiError = error.apiError;
      final forbidden =
          apiError?.code == 'CLASS_AI_MATERIALS_FORBIDDEN' ||
          apiError?.status == 403;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            (forbidden
                    ? 'teacher.content.aiMaterials.forbidden'
                    : 'teacher.content.aiMaterials.saveError')
                .tr(),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = _enabled;
    final subtitle = _loadFailed
        ? 'teacher.content.aiMaterials.loadError'.tr()
        : enabled == false
        ? 'teacher.content.aiMaterials.subtitleOff'.tr()
        : 'teacher.content.aiMaterials.subtitleOn'.tr();
    return Card(
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space16,
        0,
      ),
      child: SwitchListTile(
        key: const ValueKey('class-ai-materials-switch'),
        secondary: const Icon(Icons.auto_awesome_outlined),
        title: Text('teacher.content.aiMaterials.title'.tr()),
        subtitle: Text(subtitle),
        isThreeLine: true,
        value: enabled ?? false,
        onChanged: enabled == null || _saving ? null : _set,
      ),
    );
  }
}
