import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../student/application/materials_providers.dart';
import '../../../student/application/student_context_providers.dart';
import '../../../student/domain/material_ready_state.dart';
import '../../application/ai_source_providers.dart';
import '../../application/ask_ai_providers.dart';
import '../../data/ai_sources_client.dart';
import '../../domain/ai_source.dart';

/// The three places an AI tool can study from: the class's study materials, one of the student's
/// assignments, or their own files and photos. A segmented switch over three lists that share one
/// selection, so a quiz can mix a study material with a page of the student's own notes.
///
/// [studyMaterials] is the tool's own study-material list (the quiz, flashcard and exam pickers,
/// or a single-choice list); the other two tabs are built here. With [multiSelect] a tap toggles a
/// source in [selected]; without it a tap picks it ([onSelect] once, e.g. to close a sheet).
/// Only a source that is ready with text can be chosen.
class AiSourcePicker extends StatefulWidget {
  const AiSourcePicker({
    required this.studyMaterials,
    required this.selected,
    required this.onSelect,
    this.multiSelect = true,
    this.atLimit = false,
    this.initialTab = AiSourceKind.material,
    super.key,
  });

  final Widget studyMaterials;
  final Set<String> selected;
  final ValueChanged<AiSourceChoice> onSelect;
  final bool multiSelect;

  /// No more sources can be added (a selected one can still be removed).
  final bool atLimit;
  final AiSourceKind initialTab;

  @override
  State<AiSourcePicker> createState() => _AiSourcePickerState();
}

class _AiSourcePickerState extends State<AiSourcePicker> {
  late AiSourceKind _tab = widget.initialTab;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SegmentedButton<AiSourceKind>(
          key: const Key('aiSourceTabs'),
          showSelectedIcon: false,
          segments: [
            for (final kind in AiSourceKind.values)
              ButtonSegment(
                value: kind,
                icon: Icon(kind.icon, size: 18),
                label: Text(
                  'aiSources.tabs.${kind.name}'.tr(),
                  maxLines: 2,
                  textAlign: TextAlign.center,
                ),
              ),
          ],
          selected: {_tab},
          onSelectionChanged: (selection) => setState(() => _tab = selection.first),
        ),
        const SizedBox(height: AppSpacing.space12),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 180),
          child: KeyedSubtree(
            key: ValueKey(_tab),
            child: switch (_tab) {
              AiSourceKind.material => widget.studyMaterials,
              AiSourceKind.assignment => AiAssignmentSourceList(
                selected: widget.selected,
                onSelect: widget.onSelect,
                multiSelect: widget.multiSelect,
                atLimit: widget.atLimit,
              ),
              AiSourceKind.personal => AiPersonalSourceList(
                selected: widget.selected,
                onSelect: widget.onSelect,
                multiSelect: widget.multiSelect,
                atLimit: widget.atLimit,
              ),
            },
          ),
        ),
      ],
    );
  }
}

extension AiSourceKindUi on AiSourceKind {
  IconData get icon => switch (this) {
    AiSourceKind.material => Icons.menu_book_outlined,
    AiSourceKind.assignment => Icons.assignment_outlined,
    AiSourceKind.personal => Icons.photo_library_outlined,
  };
}

// ---------------------------------------------------------------------------------------------
// My assignments
// ---------------------------------------------------------------------------------------------

/// The student's assignments as sources. Tapping one that was never used builds its source (its
/// instructions and the teacher's attached files), which takes a moment; it becomes choosable once
/// ready, and the list follows it there on its own.
class AiAssignmentSourceList extends ConsumerStatefulWidget {
  const AiAssignmentSourceList({
    required this.selected,
    required this.onSelect,
    this.multiSelect = true,
    this.atLimit = false,
    super.key,
  });

  final Set<String> selected;
  final ValueChanged<AiSourceChoice> onSelect;
  final bool multiSelect;
  final bool atLimit;

  @override
  ConsumerState<AiAssignmentSourceList> createState() => _AiAssignmentSourceListState();
}

class _AiAssignmentSourceListState extends ConsumerState<AiAssignmentSourceList> {
  /// Assignments whose source is being requested right now.
  final Set<String> _preparing = {};

  /// What a request returned, until the list's next read catches up.
  final Map<String, AiPreparedSource> _prepared = {};

  Future<void> _use(AiAssignmentSource assignment) async {
    final studentId = ref.read(askAiStudentIdProvider);
    if (studentId == null || _preparing.contains(assignment.assignmentId)) return;
    setState(() => _preparing.add(assignment.assignmentId));
    try {
      final source = await ref
          .read(aiSourcesClientProvider)
          .prepareAssignment(studentId: studentId, assignmentId: assignment.assignmentId);
      if (!mounted) return;
      setState(() => _prepared[assignment.assignmentId] = source);
      if (source.status == AiSourceStatus.ready && source.hasText) {
        _choose(
          AiSourceChoice(id: source.id, title: assignment.title, kind: AiSourceKind.assignment),
        );
      }
      ref.invalidate(aiAssignmentSourcesProvider);
    } catch (error) {
      if (mounted) showAiSourceError(context, error);
    } finally {
      if (mounted) setState(() => _preparing.remove(assignment.assignmentId));
    }
  }

  void _choose(AiSourceChoice choice) {
    if (widget.multiSelect && widget.selected.contains(choice.id)) return;
    widget.onSelect(choice);
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(aiAssignmentSourcesProvider);
    return async.when(
      loading: () => const _ListLoading(),
      error: (error, _) => _ListError(onRetry: () => ref.invalidate(aiAssignmentSourcesProvider)),
      data: (assignments) {
        if (assignments.isEmpty) {
          return AppEmptyState(
            icon: Icons.assignment_outlined,
            message: 'aiSources.assignments.empty'.tr(),
            accent: AppAccent.violet,
            compact: true,
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final assignment in assignments)
              _AssignmentTile(
                assignment: switch (_prepared[assignment.assignmentId]) {
                  // The request's answer is newer than a list read from before it.
                  final AiPreparedSource source
                      when assignment.sourceId == null ||
                          (assignment.sourceStatus == AiSourceStatus.ready) !=
                              (source.status == AiSourceStatus.ready) =>
                    assignment.withSource(source),
                  _ => assignment,
                },
                preparing: _preparing.contains(assignment.assignmentId),
                selected:
                    assignment.sourceId != null && widget.selected.contains(assignment.sourceId),
                multiSelect: widget.multiSelect,
                atLimit: widget.atLimit,
                onUse: _use,
                onToggle: (choice) => widget.onSelect(choice),
              ),
          ],
        );
      },
    );
  }
}

class _AssignmentTile extends StatelessWidget {
  const _AssignmentTile({
    required this.assignment,
    required this.preparing,
    required this.selected,
    required this.multiSelect,
    required this.atLimit,
    required this.onUse,
    required this.onToggle,
  });

  final AiAssignmentSource assignment;
  final bool preparing;
  final bool selected;
  final bool multiSelect;
  final bool atLimit;
  final ValueChanged<AiAssignmentSource> onUse;
  final ValueChanged<AiSourceChoice> onToggle;

  @override
  Widget build(BuildContext context) {
    final status = assignment.sourceStatus;
    final ready = status == AiSourceStatus.ready;
    final sourceId = assignment.sourceId;
    final locale = context.locale.toString();
    final details = [
      ?assignment.classCode,
      'aiSources.assignments.due'.tr(
        namedArgs: {'date': DateFormat.MMMd(locale).format(assignment.dueAt.toLocal())},
      ),
      if (assignment.attachmentCount > 0)
        'aiSources.assignments.files'.tr(namedArgs: {'count': '${assignment.attachmentCount}'}),
    ].join(' · ');

    final Widget trailing;
    final VoidCallback? onTap;
    if (!assignment.aiEnabled) {
      trailing = AppStatusPill(
        label: 'aiSources.assignments.aiOff'.tr(),
        tone: AppTone.neutral,
        icon: Icons.block,
      );
      onTap = null;
    } else if (preparing || (status?.inFlight ?? false)) {
      trailing = _PreparingPill(label: 'aiSources.status.processing'.tr());
      onTap = null;
    } else if (ready && sourceId != null) {
      final choice = AiSourceChoice(
        id: sourceId,
        title: assignment.title,
        kind: AiSourceKind.assignment,
      );
      final enabled = selected || !atLimit;
      trailing = multiSelect
          ? Checkbox(value: selected, onChanged: enabled ? (_) => onToggle(choice) : null)
          : Icon(Icons.chevron_right_rounded, color: Theme.of(context).colorScheme.primary);
      onTap = enabled ? () => onToggle(choice) : null;
    } else {
      trailing = status == AiSourceStatus.failed
          ? AppStatusPill(
              label: 'aiSources.status.retry'.tr(),
              tone: AppTone.warning,
              icon: Icons.refresh,
            )
          : FilledButton.tonal(
              onPressed: atLimit && multiSelect ? null : () => onUse(assignment),
              child: Text('aiSources.assignments.use'.tr()),
            );
      onTap = atLimit && multiSelect ? null : () => onUse(assignment);
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: _SourceCard(
        selected: selected,
        onTap: onTap,
        child: AppIconListTile(
          title: assignment.title,
          subtitle: details,
          icon: Icons.assignment_outlined,
          accent: AppAccent.violet,
          trailing: trailing,
          showChevron: false,
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.space12,
            vertical: AppSpacing.space8,
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// My files & photos
// ---------------------------------------------------------------------------------------------

/// The student's own files and photos: upload a document, take a photo or choose one from the
/// gallery; follow each through the virus check and the reading of its text; delete one. Only
/// the student can see them.
class AiPersonalSourceList extends ConsumerStatefulWidget {
  const AiPersonalSourceList({
    required this.selected,
    required this.onSelect,
    this.multiSelect = true,
    this.atLimit = false,
    super.key,
  });

  final Set<String> selected;
  final ValueChanged<AiSourceChoice> onSelect;
  final bool multiSelect;
  final bool atLimit;

  @override
  ConsumerState<AiPersonalSourceList> createState() => _AiPersonalSourceListState();
}

class _AiPersonalSourceListState extends ConsumerState<AiPersonalSourceList> {
  /// The file going up right now, and how far along it is (null: not measurable yet).
  String? _uploadingName;
  double? _progress;

  Future<void> _add(Future<AiSourceFile?> Function(AiSourceFilePicker picker) pick) async {
    final studentId = ref.read(askAiStudentIdProvider);
    if (studentId == null || _uploadingName != null) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final file = await pick(ref.read(aiSourceFilePickerProvider));
      if (file == null || !mounted) return;
      setState(() {
        _uploadingName = file.name;
        _progress = null;
      });
      await ref
          .read(aiSourcesClientProvider)
          .upload(
            studentId: studentId,
            file: file,
            onProgress: (progress) {
              if (mounted) setState(() => _progress = progress);
            },
          );
      messenger.showSnackBar(SnackBar(content: Text('aiSources.files.uploaded'.tr())));
    } catch (error) {
      if (mounted) showAiSourceError(context, error);
    } finally {
      if (mounted) {
        setState(() {
          _uploadingName = null;
          _progress = null;
        });
      }
      ref.invalidate(aiPersonalSourcesProvider);
    }
  }

  Future<void> _delete(AiPersonalSource source) async {
    final studentId = ref.read(askAiStudentIdProvider);
    if (studentId == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('aiSources.files.deleteTitle'.tr()),
        content: Text('aiSources.files.deleteBody'.tr()),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text('aiSources.files.cancel'.tr()),
          ),
          FilledButton(
            key: const Key('aiSourceDeleteConfirm'),
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
              foregroundColor: Theme.of(context).colorScheme.onError,
            ),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text('aiSources.files.delete'.tr()),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(aiSourcesClientProvider).delete(studentId: studentId, sourceId: source.id);
      // A deleted source leaves a multi-source selection (a tap would toggle it off).
      if (widget.multiSelect && widget.selected.contains(source.id)) {
        widget.onSelect(source.choice);
      }
      messenger.showSnackBar(SnackBar(content: Text('aiSources.files.deleted'.tr())));
    } catch (error) {
      if (mounted) showAiSourceError(context, error);
    } finally {
      ref.invalidate(aiPersonalSourcesProvider);
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(aiPersonalSourcesProvider);
    final theme = Theme.of(context);
    final usage = async.value?.usage ?? AiSourceUsage.empty;
    final busy = _uploadingName != null;
    final canAdd = !busy && !usage.full;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(Icons.lock_outline, size: 16, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                'aiSources.files.intro'.tr(),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space12),
        Row(
          children: [
            Expanded(
              child: _AddButton(
                key: const Key('aiSourceUploadFile'),
                icon: Icons.upload_file_outlined,
                label: 'aiSources.files.uploadFile'.tr(),
                onPressed: canAdd ? () => _add((picker) => picker.pickDocument()) : null,
              ),
            ),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: _AddButton(
                key: const Key('aiSourceTakePhoto'),
                icon: Icons.photo_camera_outlined,
                label: 'aiSources.files.takePhoto'.tr(),
                onPressed: canAdd
                    ? () => _add((picker) => picker.pickPhoto(ImageSource.camera))
                    : null,
              ),
            ),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: _AddButton(
                key: const Key('aiSourceChoosePhoto'),
                icon: Icons.photo_library_outlined,
                label: 'aiSources.files.choosePhoto'.tr(),
                onPressed: canAdd
                    ? () => _add((picker) => picker.pickPhoto(ImageSource.gallery))
                    : null,
              ),
            ),
          ],
        ),
        if (usage.maxCount > 0) ...[
          const SizedBox(height: AppSpacing.space8),
          Text(
            'aiSources.files.usage'.tr(
              namedArgs: {
                'count': '${usage.count}',
                'max': '${usage.maxCount}',
                'months': '${usage.retentionMonths}',
              },
            ),
            style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ],
        if (busy) ...[
          const SizedBox(height: AppSpacing.space12),
          _UploadingRow(name: _uploadingName!, progress: _progress),
        ],
        const SizedBox(height: AppSpacing.space12),
        async.when(
          skipLoadingOnRefresh: true,
          loading: () => const _ListLoading(),
          error: (error, _) => _ListError(onRetry: () => ref.invalidate(aiPersonalSourcesProvider)),
          data: (data) {
            if (data.sources.isEmpty) {
              return AppEmptyState(
                icon: Icons.note_add_outlined,
                message: 'aiSources.files.empty'.tr(),
                accent: AppAccent.teal,
                compact: true,
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final source in data.sources)
                  _PersonalSourceTile(
                    source: source,
                    selected: widget.selected.contains(source.id),
                    multiSelect: widget.multiSelect,
                    atLimit: widget.atLimit,
                    onToggle: widget.onSelect,
                    onDelete: _delete,
                  ),
              ],
            );
          },
        ),
      ],
    );
  }
}

class _PersonalSourceTile extends StatelessWidget {
  const _PersonalSourceTile({
    required this.source,
    required this.selected,
    required this.multiSelect,
    required this.atLimit,
    required this.onToggle,
    required this.onDelete,
  });

  final AiPersonalSource source;
  final bool selected;
  final bool multiSelect;
  final bool atLimit;
  final ValueChanged<AiSourceChoice> onToggle;
  final ValueChanged<AiPersonalSource> onDelete;

  @override
  Widget build(BuildContext context) {
    final usable = source.usable;
    final enabled = usable && (selected || !atLimit);
    final pill = _statusPill(context);

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: _SourceCard(
        selected: selected,
        onTap: enabled ? () => onToggle(source.choice) : null,
        child: AppIconListTile(
          title: source.title,
          subtitle: source.fileName,
          icon: source.isPhoto ? Icons.image_outlined : Icons.description_outlined,
          accent: source.isPhoto ? AppAccent.teal : AppAccent.blue,
          showChevron: false,
          footer: pill == null
              ? null
              : Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.space4),
                  child: Align(alignment: AlignmentDirectional.centerStart, child: pill),
                ),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (usable && multiSelect)
                Checkbox(
                  value: selected,
                  onChanged: enabled ? (_) => onToggle(source.choice) : null,
                ),
              IconButton(
                key: Key('aiSourceDelete-${source.id}'),
                tooltip: 'aiSources.files.delete'.tr(),
                icon: const Icon(Icons.delete_outline),
                onPressed: source.status.inFlight ? null : () => onDelete(source),
              ),
            ],
          ),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.space12,
            vertical: AppSpacing.space8,
          ),
        ),
      ),
    );
  }

  Widget? _statusPill(BuildContext context) {
    if (source.status.inFlight) {
      return _PreparingPill(label: 'aiSources.status.${source.status.name}'.tr());
    }
    return switch (source.status) {
      AiSourceStatus.ready when !source.hasText => AppStatusPill(
        label: 'aiSources.status.noText'.tr(),
        tone: AppTone.warning,
        icon: Icons.text_fields,
      ),
      AiSourceStatus.ready => AppStatusPill(
        label: 'aiSources.status.ready'.tr(),
        tone: AppTone.success,
        icon: Icons.check_circle_outline,
      ),
      AiSourceStatus.blocked => AppStatusPill(
        label: 'aiSources.status.blocked'.tr(),
        tone: AppTone.danger,
        icon: Icons.gpp_bad_outlined,
      ),
      _ => AppStatusPill(
        label: 'aiSources.status.failed'.tr(),
        tone: AppTone.danger,
        icon: Icons.error_outline,
      ),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

/// A source's card, outlined in the brand colour while it is selected.
class _SourceCard extends StatelessWidget {
  const _SourceCard({required this.child, required this.selected, this.onTap});

  final Widget child;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: selected ? colors.primaryContainer.withValues(alpha: 0.35) : colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: AppRadius.lgRadius,
        side: BorderSide(
          color: selected ? colors.primary : colors.outlineVariant,
          width: selected ? 1.5 : 1,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(onTap: onTap, child: child),
    );
  }
}

class _AddButton extends StatelessWidget {
  const _AddButton({required this.icon, required this.label, this.onPressed, super.key});

  final IconData icon;
  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return FilledButton.tonal(
      onPressed: onPressed,
      style: FilledButton.styleFrom(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space8,
          vertical: AppSpacing.space12,
        ),
        shape: const RoundedRectangleBorder(borderRadius: AppRadius.lgRadius),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon),
          const SizedBox(height: AppSpacing.space4),
          Text(label, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis),
        ],
      ),
    );
  }
}

class _UploadingRow extends StatelessWidget {
  const _UploadingRow({required this.name, required this.progress});

  final String name;
  final double? progress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppCardSurface(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'aiSources.files.uploading'.tr(namedArgs: {'name': name}),
              style: theme.textTheme.bodyMedium,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: AppSpacing.space8),
            ClipRRect(
              borderRadius: AppRadius.smRadius,
              child: LinearProgressIndicator(value: progress),
            ),
          ],
        ),
      ),
    );
  }
}

class _PreparingPill extends StatelessWidget {
  const _PreparingPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = AppTone.info.colorsOf(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space8, vertical: 4),
      decoration: BoxDecoration(color: colors.container, borderRadius: AppRadius.smRadius),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 2, color: colors.onContainer),
          ),
          const SizedBox(width: AppSpacing.space4),
          Text(
            label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(color: colors.onContainer),
          ),
        ],
      ),
    );
  }
}

class _ListLoading extends StatelessWidget {
  const _ListLoading();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: AppSpacing.space16),
      child: LinearProgressIndicator(),
    );
  }
}

class _ListError extends StatelessWidget {
  const _ListError({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return AppEmptyState(
      icon: Icons.cloud_off_outlined,
      message: 'aiSources.errors.load'.tr(),
      accent: AppAccent.slate,
      compact: true,
      action: TextButton(onPressed: onRetry, child: Text('aiStudy.retry'.tr())),
    );
  }
}

/// Tells the student why a source could not be added, used or deleted.
void showAiSourceError(BuildContext context, Object error) {
  final key = switch (error) {
    AiSourceUnsupportedFile() => 'aiSources.errors.unsupported',
    PlatformException(code: 'camera_access_denied' || 'photo_access_denied') =>
      'aiSources.errors.permission',
    DioException(:final apiError) => switch (apiError?.code) {
      'AI_SOURCE_UNSUPPORTED_TYPE' => 'aiSources.errors.unsupported',
      'AI_SOURCE_TOO_LARGE' => 'aiSources.errors.tooLarge',
      'AI_SOURCE_LIMIT_REACHED' => 'aiSources.errors.limit',
      'AI_SOURCE_AI_DISABLED' => 'aiSources.errors.aiOff',
      'AI_MODERATION_INPUT_BLOCKED' => 'aiSources.errors.name',
      'STORAGE_QUOTA_EXCEEDED' => 'aiSources.errors.storageFull',
      _ when error.type == DioExceptionType.connectionError => 'aiSources.errors.network',
      _ => 'aiSources.errors.generic',
    },
    _ => 'aiSources.errors.generic',
  };
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(key.tr())));
}

// ---------------------------------------------------------------------------------------------
// Study materials, one to choose
// ---------------------------------------------------------------------------------------------

/// The "Study materials" tab for a single choice: the ready, AI-shared materials of each class the
/// student is enrolled in. [leading] goes above them (Explain's "All my study materials").
class AiStudyMaterialChoiceList extends ConsumerWidget {
  const AiStudyMaterialChoiceList({
    required this.onSelect,
    this.selectedId,
    this.leading,
    super.key,
  });

  final ValueChanged<AiSourceChoice> onSelect;
  final String? selectedId;
  final Widget? leading;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classIds = ref.watch(currentEnrolledClassIdsProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ?leading,
        if (classIds.isEmpty)
          AppEmptyState(
            icon: Icons.menu_book_outlined,
            message: 'aiSources.chooser.materialsEmpty'.tr(),
            compact: true,
          )
        else
          for (final classId in classIds)
            _ClassChoiceList(classId: classId, selectedId: selectedId, onSelect: onSelect),
      ],
    );
  }
}

class _ClassChoiceList extends ConsumerWidget {
  const _ClassChoiceList({required this.classId, required this.selectedId, required this.onSelect});

  final String classId;
  final String? selectedId;
  final ValueChanged<AiSourceChoice> onSelect;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final classCode = ref.watch(materialsClassCodeProvider(classId));
    final theme = Theme.of(context);
    return ref
        .watch(materialsForClassProvider(classId))
        .when(
          loading: () => const _ListLoading(),
          error: (error, stackTrace) => const SizedBox.shrink(),
          data: (cached) {
            final ready = [
              for (final material in cached.data)
                if (material.aiVisible &&
                    materialReadyStateFromWireName(material.ingestStatus.name) ==
                        MaterialReadyState.ready)
                  material,
            ];
            if (ready.isEmpty) return const SizedBox.shrink();
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.space8, bottom: AppSpacing.space4),
                  child: Text(
                    classCode.value ?? 'materials.unknownClass'.tr(),
                    style: theme.textTheme.labelLarge?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
                for (final material in ready)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                    child: _SourceCard(
                      selected: material.id == selectedId,
                      onTap: () => onSelect(
                        AiSourceChoice(
                          id: material.id,
                          title: material.title,
                          kind: AiSourceKind.material,
                        ),
                      ),
                      child: AppIconListTile(
                        title: material.title,
                        icon: Icons.description_outlined,
                        showChevron: true,
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.space12,
                          vertical: AppSpacing.space8,
                        ),
                      ),
                    ),
                  ),
              ],
            );
          },
        );
  }
}
