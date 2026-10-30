import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mime/mime.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/assignment_attachment.dart';
import '../../../core/api/generated/models/assignment_kind.dart';
import '../../../core/api/generated/models/assignment_status.dart';
import '../../../core/api/generated/models/confirm_attachment_body.dart';
import '../../../core/api/generated/models/confirm_upload_body.dart';
import '../../../core/api/generated/models/create_assignment_body.dart';
import '../../../core/api/generated/models/create_assignment_body_kind.dart';
import '../../../core/api/generated/models/create_assignment_body_status.dart';
import '../../../core/api/generated/models/create_material_body.dart';
import '../../../core/api/generated/models/create_upload_url_body.dart';
import '../../../core/api/generated/models/material.dart' as material_api;
import '../../../core/api/generated/models/update_assignment_body.dart';
import '../../../core/api/generated/models/update_assignment_body_status.dart';
import '../../../core/api/generated/models/update_material_body.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/files/picked_file.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/domain/material_ready_state.dart';
import '../../student/presentation/widgets/material_ready_state_pill.dart';
import 'assignment_submissions_screen.dart';
import 'question_editor_screen.dart';

/// Teacher-owned content for one class: create and edit assignments, upload and edit materials.
///
/// Material rows are periodically refreshed while their server-side scan or AI ingestion is
/// active, so the transition to Ready is visible without requiring the teacher to leave and
/// return.
class TeacherContentScreen extends ConsumerStatefulWidget {
  const TeacherContentScreen({
    required this.classId,
    required this.classCode,
    super.key,
  });

  final String classId;
  final String classCode;

  @override
  ConsumerState<TeacherContentScreen> createState() =>
      _TeacherContentScreenState();
}

class _TeacherContentScreenState extends ConsumerState<TeacherContentScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;
  late Future<List<Assignment>> _assignments;
  late Future<List<material_api.Material>> _materials;
  Timer? _materialRefresh;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _assignments = _loadAssignments();
    _materials = _loadMaterials();
    _materialRefresh = Timer.periodic(
      const Duration(seconds: 8),
      (_) => _refreshMaterials(),
    );
  }

  Future<List<Assignment>> _loadAssignments() async =>
      (await ref
              .read(apiClientProvider)
              .assignments
              .listAssignments(classId: widget.classId, limit: 100))
          .assignments;

  Future<List<material_api.Material>> _loadMaterials() async =>
      (await ref
              .read(apiClientProvider)
              .academics
              .listMaterials(classId: widget.classId, limit: 100))
          .materials;

  // Block-bodied closures: an arrow would return the assigned Future, which setState rejects.
  void _refreshAssignments() {
    if (!mounted) return;
    setState(() {
      _assignments = _loadAssignments();
    });
  }

  void _refreshMaterials() {
    if (!mounted) return;
    setState(() {
      _materials = _loadMaterials();
    });
  }

  @override
  void dispose() {
    _materialRefresh?.cancel();
    _tabs.dispose();
    super.dispose();
  }

  /// Pushes [page] and refreshes the matching list when it pops with `true` (something saved).
  Future<void> _open(Widget page, {required bool assignments}) async {
    final changed = await Navigator.of(
      context,
    ).push<bool>(MaterialPageRoute(builder: (_) => page));
    if (changed == true) {
      assignments ? _refreshAssignments() : _refreshMaterials();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.classCode),
      bottom: TabBar(
        controller: _tabs,
        tabs: [
          Tab(text: 'teacher.content.tabs.assignments'.tr()),
          Tab(text: 'teacher.content.tabs.materials'.tr()),
        ],
      ),
    ),
    floatingActionButton: AnimatedBuilder(
      animation: _tabs,
      builder: (context, _) => FloatingActionButton.extended(
        icon: Icon(
          _tabs.index == 0
              ? Icons.add_task_outlined
              : Icons.upload_file_outlined,
        ),
        label: Text(
          _tabs.index == 0
              ? 'teacher.content.assignments.create'.tr()
              : 'teacher.content.materials.upload'.tr(),
        ),
        onPressed: () => _tabs.index == 0
            ? _open(
                _AssignmentComposer(classId: widget.classId),
                assignments: true,
              )
            : _open(
                _MaterialComposer(classId: widget.classId),
                assignments: false,
              ),
      ),
    ),
    body: TabBarView(
      controller: _tabs,
      children: [
        _AssignmentList(
          future: _assignments,
          onRefresh: _refreshAssignments,
          onEdit: (assignment) => _open(
            _AssignmentComposer(classId: widget.classId, existing: assignment),
            assignments: true,
          ),
        ),
        _MaterialList(
          future: _materials,
          onRefresh: _refreshMaterials,
          onEdit: (material) =>
              _open(_MaterialEditor(material: material), assignments: false),
        ),
      ],
    ),
  );
}

/// Maps an API rejection to a translation key. Branches on the stable `code`, falling back to
/// the HTTP status for bodies that carry none, then to [fallbackKey].
String _errorKeyFor(DioException error, String fallbackKey) {
  final apiError = error.apiError;
  return switch (apiError?.code) {
    'ASSIGNMENT_INVALID_STATUS_TRANSITION' =>
      'teacher.content.errors.statusTransition',
    'ASSIGNMENT_QUESTIONS_REQUIRED' => 'teacher.questions.errors.empty',
    'ASSIGNMENT_QUESTIONS_LOCKED' => 'teacher.questions.errors.locked',
    'VALIDATION_FAILED' => 'teacher.content.errors.validation',
    'AUTHZ_FORBIDDEN' => 'teacher.content.errors.forbidden',
    'RESOURCE_NOT_FOUND' ||
    'MATERIAL_NOT_FOUND' => 'teacher.content.errors.notFound',
    _ => switch (apiError?.status) {
      400 || 422 => 'teacher.content.errors.validation',
      403 => 'teacher.content.errors.forbidden',
      404 => 'teacher.content.errors.notFound',
      _ => fallbackKey,
    },
  };
}

String _statusLabel(AssignmentStatus status) => switch (status) {
  AssignmentStatus.draft => 'teacher.content.status.draft'.tr(),
  AssignmentStatus.published => 'teacher.content.status.published'.tr(),
  AssignmentStatus.closed => 'teacher.content.status.closed'.tr(),
  AssignmentStatus.archived => 'teacher.content.status.archived'.tr(),
  AssignmentStatus.$unknown => status.toString(),
};

class _AssignmentList extends StatelessWidget {
  const _AssignmentList({
    required this.future,
    required this.onRefresh,
    required this.onEdit,
  });
  final Future<List<Assignment>> future;
  final VoidCallback onRefresh;
  final ValueChanged<Assignment> onEdit;

  @override
  Widget build(BuildContext context) => FutureBuilder<List<Assignment>>(
    future: future,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const Center(child: CircularProgressIndicator());
      }
      if (snapshot.hasError) {
        return _Message(
          icon: Icons.error_outline,
          text: 'teacher.content.assignments.loadError'.tr(),
        );
      }
      final assignments = snapshot.data!;
      return RefreshIndicator(
        onRefresh: () async => onRefresh(),
        child: assignments.isEmpty
            ? _Message(
                icon: Icons.assignment_outlined,
                text: 'teacher.content.assignments.empty'.tr(),
              )
            : ListView.separated(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(AppSpacing.space16),
                itemCount: assignments.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(height: AppSpacing.space8),
                itemBuilder: (_, index) {
                  final item = assignments[index];
                  final isQuestions = item.kind == AssignmentKind.questions;
                  return Card(
                    child: ListTile(
                      leading: Icon(
                        isQuestions
                            ? Icons.quiz_outlined
                            : Icons.assignment_outlined,
                      ),
                      title: Text(item.title),
                      subtitle: Text(
                        'teacher.content.assignments.subtitle'.tr(
                          namedArgs: {
                            'date': MaterialLocalizations.of(
                              context,
                            ).formatMediumDate(item.dueAt.toLocal()),
                            'points': '${item.maxScore}',
                            'status': _statusLabel(item.status),
                          },
                        ),
                      ),
                      onTap: () => onEdit(item),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (item.attachments.isNotEmpty)
                            Badge(label: Text('${item.attachments.length}')),
                          IconButton(
                            icon: const Icon(Icons.fact_check_outlined),
                            tooltip: 'teacher.submissions.open'.tr(),
                            onPressed: () => Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => AssignmentSubmissionsScreen(
                                  assignment: item,
                                ),
                              ),
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.edit_outlined),
                            tooltip: 'teacher.content.assignments.edit'.tr(),
                            onPressed: () => onEdit(item),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
      );
    },
  );
}

class _MaterialList extends StatelessWidget {
  const _MaterialList({
    required this.future,
    required this.onRefresh,
    required this.onEdit,
  });
  final Future<List<material_api.Material>> future;
  final VoidCallback onRefresh;
  final ValueChanged<material_api.Material> onEdit;

  @override
  Widget build(
    BuildContext context,
  ) => FutureBuilder<List<material_api.Material>>(
    future: future,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const Center(child: CircularProgressIndicator());
      }
      if (snapshot.hasError) {
        return _Message(
          icon: Icons.error_outline,
          text: 'teacher.content.materials.loadError'.tr(),
        );
      }
      final materials = snapshot.data!;
      return RefreshIndicator(
        onRefresh: () async => onRefresh(),
        child: materials.isEmpty
            ? _Message(
                icon: Icons.folder_open_outlined,
                text: 'teacher.content.materials.empty'.tr(),
              )
            : ListView.separated(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(AppSpacing.space16),
                itemCount: materials.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(height: AppSpacing.space8),
                itemBuilder: (_, index) {
                  final material = materials[index];
                  final description = material.description;
                  return Card(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(
                        AppSpacing.space12,
                        AppSpacing.space8,
                        AppSpacing.space8,
                        AppSpacing.space8,
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  material.title,
                                  style: Theme.of(context).textTheme.titleSmall,
                                ),
                              ),
                              IconButton(
                                icon: const Icon(Icons.edit_outlined),
                                tooltip: 'teacher.content.materials.edit'.tr(),
                                onPressed: () => onEdit(material),
                              ),
                            ],
                          ),
                          if (description != null && description.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.only(
                                bottom: AppSpacing.space4,
                              ),
                              child: Text(
                                description,
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                            ),
                          MaterialReadyStatePill(
                            state: materialReadyStateFromWireName(
                              material.ingestStatus.name,
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
      );
    },
  );
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    children: [
      Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          children: [
            Icon(icon, size: 32),
            const SizedBox(height: AppSpacing.space12),
            Text(text),
          ],
        ),
      ),
    ],
  );
}

class _FormError extends StatelessWidget {
  const _FormError(this.messageKey);
  final String messageKey;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: AppSpacing.space12),
    child: Text(
      messageKey.tr(),
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    ),
  );
}

class _LocalFile {
  const _LocalFile(this.path, this.name, this.sizeBytes);
  final String path;
  final String name;
  final int sizeBytes;
  String get contentType => lookupMimeType(path) ?? 'application/octet-stream';
}

/// Creates an assignment, or edits [existing] when given. Editing prefills every field, lets the
/// teacher move the lifecycle forward (never back to draft -- the API rejects that with 409), and
/// add or remove attachments.
class _AssignmentComposer extends ConsumerStatefulWidget {
  const _AssignmentComposer({required this.classId, this.existing});
  final String classId;
  final Assignment? existing;
  @override
  ConsumerState<_AssignmentComposer> createState() =>
      _AssignmentComposerState();
}

class _AssignmentComposerState extends ConsumerState<_AssignmentComposer> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _title;
  late final TextEditingController _details;
  late final TextEditingController _score;
  final List<_LocalFile> _attachments = [];
  final Set<String> _removedAttachmentIds = {};
  late DateTime _dueAt;
  late bool _lateAllowed;
  late AssignmentStatus _status;
  late CreateAssignmentBodyKind _kind;
  bool _saving = false;
  String? _errorKey;

  bool get _editing => widget.existing != null;

  /// A questions assignment's total is the sum of its question points (set by the API), so the
  /// form doesn't ask for one, and a new one is created as a draft: it has no questions yet.
  bool get _isQuestions => _editing
      ? widget.existing!.kind == AssignmentKind.questions
      : _kind == CreateAssignmentBodyKind.questions;

  /// Statuses offered in the picker. A draft may stay a draft or be published; once published the
  /// assignment can only move between published and closed (archiving happens via delete).
  List<AssignmentStatus> get _statusOptions {
    final current = widget.existing?.status ?? AssignmentStatus.published;
    return [
      if (!_editing || current == AssignmentStatus.draft)
        AssignmentStatus.draft,
      AssignmentStatus.published,
      if (_editing) AssignmentStatus.closed,
      if (current == AssignmentStatus.archived) AssignmentStatus.archived,
    ];
  }

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    _title = TextEditingController(text: existing?.title ?? '');
    _details = TextEditingController(text: existing?.description ?? '');
    _score = TextEditingController(text: '${existing?.maxScore ?? 100}');
    _dueAt =
        existing?.dueAt.toLocal() ??
        DateTime.now().add(const Duration(days: 7));
    _lateAllowed = existing?.allowLateSubmission ?? false;
    _status = existing?.status ?? AssignmentStatus.published;
    _kind = CreateAssignmentBodyKind.written;
  }

  @override
  void dispose() {
    _title.dispose();
    _details.dispose();
    _score.dispose();
    super.dispose();
  }

  Future<void> _pickFiles() async {
    final selected = await pickLocalFiles();
    if (selected.isEmpty || !mounted) {
      return;
    }
    setState(
      () => _attachments.addAll(
        selected.map((f) => _LocalFile(f.path, f.name, f.sizeBytes)),
      ),
    );
  }

  Future<void> _pickDueDate() async {
    final now = DateTime.now();
    // An assignment being edited may already be past due; the picker requires the initial date to
    // fall inside its range.
    final firstDate = _dueAt.isBefore(now) ? _dueAt : now;
    final date = await showDatePicker(
      context: context,
      initialDate: _dueAt,
      firstDate: firstDate,
      lastDate: now.add(const Duration(days: 3650)),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_dueAt),
    );
    if (time != null) {
      setState(
        () => _dueAt = DateTime(
          date.year,
          date.month,
          date.day,
          time.hour,
          time.minute,
        ),
      );
    }
  }

  Future<Assignment> _persist() {
    final api = ref.read(apiClientProvider).assignments;
    final description = _details.text.trim().isEmpty
        ? null
        : _details.text.trim();
    final existing = widget.existing;
    if (existing == null) {
      return api.createAssignment(
        body: CreateAssignmentBody(
          classId: widget.classId,
          title: _title.text.trim(),
          description: description,
          dueAt: _dueAt.toUtc(),
          // Replaced by the question total once questions are saved.
          maxScore: _isQuestions ? 1 : num.parse(_score.text),
          allowLateSubmission: _lateAllowed,
          status: _isQuestions
              ? CreateAssignmentBodyStatus.draft
              : CreateAssignmentBodyStatus.fromJson(_status.json!),
          kind: _kind,
        ),
      );
    }
    // The generated body serialises every field, nulls included, and the API reads a null as
    // "clear" (or rejects it for required columns). So send the full resolved state, carrying the
    // fields this form doesn't edit over from the stored row.
    return api.updateAssignment(
      assignmentId: existing.id,
      body: UpdateAssignmentBody(
        title: _title.text.trim(),
        description: description,
        instructions: existing.instructions,
        availableFrom: existing.availableFrom,
        dueAt: _dueAt.toUtc(),
        maxScore: _isQuestions ? existing.maxScore : num.parse(_score.text),
        allowLateSubmission: _lateAllowed,
        status: UpdateAssignmentBodyStatus.fromJson(_status.json!),
      ),
    );
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _errorKey = null;
    });
    try {
      final api = ref.read(apiClientProvider).assignments;
      final assignment = await _persist();
      for (final attachmentId in _removedAttachmentIds) {
        await api.deleteAssignmentAttachment(
          assignmentId: assignment.id,
          attachmentId: attachmentId,
        );
      }
      for (final file in _attachments) {
        final upload = await api.createAssignmentAttachmentUploadUrl(
          assignmentId: assignment.id,
          body: CreateUploadUrlBody(
            fileName: file.name,
            contentType: file.contentType,
          ),
        );
        await Dio().put<void>(
          upload.uploadUrl,
          data: File(file.path).openRead(),
          options: Options(
            contentType: file.contentType,
            headers: {Headers.contentLengthHeader: file.sizeBytes},
          ),
        );
        await api.confirmAssignmentAttachment(
          assignmentId: assignment.id,
          body: ConfirmAttachmentBody(storageKey: upload.storageKey),
        );
      }
      if (!mounted) return;
      if (!_editing && _isQuestions) {
        // Straight on to writing the questions. The draft exists either way, so the list
        // refreshes whether or not the teacher saves them now.
        await Navigator.of(context).push<bool>(
          MaterialPageRoute(
            builder: (_) => QuestionEditorScreen(assignment: assignment),
          ),
        );
        if (mounted) Navigator.of(context).pop(true);
        return;
      }
      Navigator.of(context).pop(true);
    } on DioException catch (error) {
      setState(() => _errorKey = _errorKeyFor(error, _fallbackErrorKey));
    } catch (_) {
      setState(() => _errorKey = _fallbackErrorKey);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String get _fallbackErrorKey => _editing
      ? 'teacher.content.errors.save'
      : 'teacher.content.errors.createAssignment';

  String get _submitKey => _editing
      ? 'teacher.content.assignmentForm.save'
      : _isQuestions
      ? 'teacher.questions.next'
      : _status == AssignmentStatus.draft
      ? 'teacher.content.assignmentForm.saveDraft'
      : 'teacher.content.assignmentForm.publish';

  @override
  Widget build(BuildContext context) {
    final keptAttachments = <AssignmentAttachment>[
      for (final attachment
          in widget.existing?.attachments ?? const <AssignmentAttachment>[])
        if (!_removedAttachmentIds.contains(attachment.id)) attachment,
    ];
    return Scaffold(
      appBar: AppBar(
        title: Text(
          (_editing
                  ? 'teacher.content.assignments.edit'
                  : 'teacher.content.assignments.create')
              .tr(),
        ),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.space16),
          children: [
            if (!_editing) ...[
              SegmentedButton<CreateAssignmentBodyKind>(
                key: const Key('assignmentKind'),
                segments: [
                  ButtonSegment(
                    value: CreateAssignmentBodyKind.written,
                    icon: const Icon(Icons.edit_note),
                    label: Text('teacher.questions.kinds.written'.tr()),
                  ),
                  ButtonSegment(
                    value: CreateAssignmentBodyKind.questions,
                    icon: const Icon(Icons.quiz_outlined),
                    label: Text('teacher.questions.kinds.questions'.tr()),
                  ),
                ],
                selected: {_kind},
                onSelectionChanged: _saving
                    ? null
                    : (selection) => setState(() => _kind = selection.single),
              ),
              const SizedBox(height: AppSpacing.space16),
            ],
            TextFormField(
              controller: _title,
              decoration: InputDecoration(
                labelText: 'teacher.content.assignmentForm.title'.tr(),
              ),
              maxLength: 200,
              validator: (v) => v == null || v.trim().isEmpty
                  ? 'teacher.content.assignmentForm.titleRequired'.tr()
                  : null,
            ),
            const SizedBox(height: AppSpacing.space12),
            TextFormField(
              controller: _details,
              decoration: InputDecoration(
                labelText: 'teacher.content.assignmentForm.details'.tr(),
              ),
              maxLength: 2000,
              minLines: 3,
              maxLines: 6,
            ),
            if (_isQuestions && _editing) ...[
              const SizedBox(height: AppSpacing.space12),
              OutlinedButton.icon(
                key: const Key('assignmentEditQuestions'),
                onPressed: _saving
                    ? null
                    : () async {
                        final saved = await Navigator.of(context).push<bool>(
                          MaterialPageRoute(
                            builder: (_) => QuestionEditorScreen(
                              assignment: widget.existing!,
                            ),
                          ),
                        );
                        if (saved == true && context.mounted) {
                          Navigator.of(context).pop(true);
                        }
                      },
                icon: const Icon(Icons.quiz_outlined),
                label: Text(
                  'teacher.questions.edit'.tr(
                    namedArgs: {
                      'count': '${widget.existing!.questions.length}',
                      'points': '${widget.existing!.maxScore}',
                    },
                  ),
                ),
              ),
            ],
            if (!_isQuestions) ...[
              const SizedBox(height: AppSpacing.space12),
              TextFormField(
                controller: _score,
                decoration: InputDecoration(
                  labelText: 'teacher.content.assignmentForm.points'.tr(),
                ),
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                validator: (v) {
                  final points = num.tryParse(v ?? '');
                  return points == null || points <= 0
                      ? 'teacher.content.assignmentForm.pointsInvalid'.tr()
                      : null;
                },
              ),
            ],
            if (!(_isQuestions && !_editing)) ...[
              const SizedBox(height: AppSpacing.space12),
              DropdownButtonFormField<AssignmentStatus>(
                initialValue: _status,
                decoration: InputDecoration(
                  labelText: 'teacher.content.assignmentForm.status'.tr(),
                ),
                items: [
                  for (final status in _statusOptions)
                    DropdownMenuItem(
                      value: status,
                      child: Text(_statusLabel(status)),
                    ),
                ],
                onChanged: _saving
                    ? null
                    : (value) {
                        if (value != null) setState(() => _status = value);
                      },
              ),
            ],
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('teacher.content.assignmentForm.dueDate'.tr()),
              subtitle: Text(
                MaterialLocalizations.of(context).formatFullDate(_dueAt),
              ),
              trailing: const Icon(Icons.calendar_today_outlined),
              onTap: _saving ? null : _pickDueDate,
            ),
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: Text('teacher.content.assignmentForm.lateAllowed'.tr()),
              value: _lateAllowed,
              onChanged: _saving
                  ? null
                  : (v) => setState(() => _lateAllowed = v),
            ),
            for (final attachment in keptAttachments)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.insert_drive_file_outlined),
                title: Text(attachment.originalFileName),
                trailing: IconButton(
                  icon: const Icon(Icons.close),
                  tooltip: 'teacher.content.assignmentForm.removeAttachment'
                      .tr(),
                  onPressed: _saving
                      ? null
                      : () => setState(
                          () => _removedAttachmentIds.add(attachment.id),
                        ),
                ),
              ),
            for (final file in _attachments)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.insert_drive_file_outlined),
                title: Text(file.name),
                trailing: IconButton(
                  icon: const Icon(Icons.close),
                  tooltip: 'teacher.content.assignmentForm.removeAttachment'
                      .tr(),
                  onPressed: _saving
                      ? null
                      : () => setState(() => _attachments.remove(file)),
                ),
              ),
            OutlinedButton.icon(
              onPressed: _saving ? null : _pickFiles,
              icon: const Icon(Icons.attach_file),
              label: Text('teacher.content.assignmentForm.addAttachments'.tr()),
            ),
            if (_errorKey != null) _FormError(_errorKey!),
            const SizedBox(height: AppSpacing.space24),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const CircularProgressIndicator()
                  : Text(_submitKey.tr()),
            ),
          ],
        ),
      ),
    );
  }
}

class _MaterialComposer extends ConsumerStatefulWidget {
  const _MaterialComposer({required this.classId});
  final String classId;
  @override
  ConsumerState<_MaterialComposer> createState() => _MaterialComposerState();
}

class _MaterialComposerState extends ConsumerState<_MaterialComposer> {
  final _formKey = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _description = TextEditingController();
  _LocalFile? _file;
  bool _uploading = false;
  double? _progress;
  String? _errorKey;
  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _chooseFile() async {
    final picked = await pickLocalFiles(multiple: false);
    if (picked.isEmpty || !mounted) return;
    final file = picked.single;
    setState(() {
      _file = _LocalFile(file.path, file.name, file.sizeBytes);
      _title.text = _title.text.isEmpty ? file.name : _title.text;
    });
  }

  Future<void> _takePhoto() async {
    final XFile? photo;
    try {
      photo = await ImagePicker().pickImage(source: ImageSource.camera);
    } on PlatformException catch (error) {
      // iOS doesn't show the camera prompt again once it's been declined; image_picker throws.
      setState(
        () => _errorKey = error.code == 'camera_access_denied'
            ? 'teacher.content.materialForm.cameraDenied'
            : 'teacher.content.materialForm.cameraError',
      );
      return;
    }
    if (photo case final image?) {
      final size = await File(image.path).length();
      setState(() {
        _file = _LocalFile(image.path, image.name, size);
        _title.text = _title.text.isEmpty ? image.name : _title.text;
      });
    }
  }

  Future<void> _upload() async {
    if (!_formKey.currentState!.validate() || _file == null) {
      setState(() => _errorKey = 'teacher.content.materialForm.fileRequired');
      return;
    }
    final file = _file!;
    setState(() {
      _uploading = true;
      _progress = 0;
      _errorKey = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final description = _description.text.trim();
      final upload = await api.academics.initiateMaterialUpload(
        body: CreateMaterialBody(
          classId: widget.classId,
          title: _title.text.trim(),
          description: description.isEmpty ? null : description,
          originalFileName: file.name,
          mimeType: file.contentType,
          sizeBytes: file.sizeBytes,
        ),
      );
      // The initiate endpoint currently returns only the storage key. The material row is
      // created synchronously as part of that endpoint, so resolve its id before confirmation.
      final materials = await api.academics.listMaterials(
        classId: widget.classId,
        limit: 100,
      );
      final pending = materials.materials
          .where((item) => item.storageKey == upload.storageKey)
          .firstOrNull;
      if (pending == null) {
        throw StateError('The material upload could not be resolved.');
      }
      await Dio().put<void>(
        upload.uploadUrl,
        data: File(file.path).openRead(),
        options: Options(
          contentType: file.contentType,
          headers: {Headers.contentLengthHeader: file.sizeBytes},
        ),
        onSendProgress: (sent, total) {
          if (mounted) {
            setState(() => _progress = total > 0 ? sent / total : null);
          }
        },
      );
      // New materials are AI-visible by default; the clean scan hands them to AI ingestion.
      await api.academics.confirmMaterialUpload(
        materialId: pending.id,
        body: ConfirmUploadBody(storageKey: upload.storageKey),
      );
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (error) {
      setState(
        () => _errorKey = _errorKeyFor(error, 'teacher.content.errors.upload'),
      );
    } catch (_) {
      setState(() => _errorKey = 'teacher.content.errors.upload');
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text('teacher.content.materials.upload'.tr())),
    body: Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: [
          _MaterialFields(title: _title, description: _description),
          const SizedBox(height: AppSpacing.space12),
          Wrap(
            spacing: AppSpacing.space8,
            children: [
              OutlinedButton.icon(
                onPressed: _uploading ? null : _chooseFile,
                icon: const Icon(Icons.upload_file_outlined),
                label: Text('teacher.content.materialForm.chooseFile'.tr()),
              ),
              OutlinedButton.icon(
                onPressed: _uploading ? null : _takePhoto,
                icon: const Icon(Icons.camera_alt_outlined),
                label: Text('teacher.content.materialForm.camera'.tr()),
              ),
            ],
          ),
          if (_file != null)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.insert_drive_file_outlined),
              title: Text(_file!.name),
            ),
          if (_uploading)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.space12),
              child: LinearProgressIndicator(value: _progress),
            ),
          if (_errorKey != null) _FormError(_errorKey!),
          const SizedBox(height: AppSpacing.space24),
          FilledButton(
            onPressed: _uploading ? null : _upload,
            child: Text(
              (_uploading
                      ? 'teacher.content.materialForm.uploading'
                      : 'teacher.content.materials.upload')
                  .tr(),
            ),
          ),
        ],
      ),
    ),
  );
}

/// Title and description fields shared by the upload and edit forms.
class _MaterialFields extends StatelessWidget {
  const _MaterialFields({required this.title, required this.description});
  final TextEditingController title;
  final TextEditingController description;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      TextFormField(
        controller: title,
        decoration: InputDecoration(
          labelText: 'teacher.content.materialForm.title'.tr(),
        ),
        maxLength: 200,
        validator: (v) => v == null || v.trim().isEmpty
            ? 'teacher.content.materialForm.titleRequired'.tr()
            : null,
      ),
      const SizedBox(height: AppSpacing.space12),
      TextFormField(
        controller: description,
        decoration: InputDecoration(
          labelText: 'teacher.content.materialForm.description'.tr(),
        ),
        maxLength: 2000,
        minLines: 2,
        maxLines: 5,
      ),
    ],
  );
}

/// Edits an uploaded material's metadata. The file itself is immutable -- replacing it means
/// uploading a new material -- and AI visibility is toggled from the list row.
class _MaterialEditor extends ConsumerStatefulWidget {
  const _MaterialEditor({required this.material});
  final material_api.Material material;
  @override
  ConsumerState<_MaterialEditor> createState() => _MaterialEditorState();
}

class _MaterialEditorState extends ConsumerState<_MaterialEditor> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _title;
  late final TextEditingController _description;
  bool _saving = false;
  String? _errorKey;

  @override
  void initState() {
    super.initState();
    _title = TextEditingController(text: widget.material.title);
    _description = TextEditingController(
      text: widget.material.description ?? '',
    );
  }

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _errorKey = null;
    });
    try {
      final description = _description.text.trim();
      // Both fields are always sent: the generated body serialises nulls, and a null description
      // is exactly how the API clears it.
      await ref
          .read(apiClientProvider)
          .academics
          .updateMaterial(
            materialId: widget.material.id,
            body: UpdateMaterialBody(
              title: _title.text.trim(),
              description: description.isEmpty ? null : description,
            ),
          );
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (error) {
      setState(
        () => _errorKey = _errorKeyFor(error, 'teacher.content.errors.save'),
      );
    } catch (_) {
      setState(() => _errorKey = 'teacher.content.errors.save');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text('teacher.content.materials.edit'.tr())),
    body: Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: [
          _MaterialFields(title: _title, description: _description),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.insert_drive_file_outlined),
            title: Text(widget.material.originalFileName),
          ),
          if (_errorKey != null) _FormError(_errorKey!),
          const SizedBox(height: AppSpacing.space24),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const CircularProgressIndicator()
                : Text('teacher.content.materialForm.save'.tr()),
          ),
        ],
      ),
    ),
  );
}
