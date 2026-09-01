import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mime/mime.dart';

import '../../../core/api/generated/models/assignment.dart';
import '../../../core/api/generated/models/confirm_attachment_body.dart';
import '../../../core/api/generated/models/confirm_upload_body.dart';
import '../../../core/api/generated/models/create_assignment_body.dart';
import '../../../core/api/generated/models/create_assignment_body_status.dart';
import '../../../core/api/generated/models/create_material_body.dart';
import '../../../core/api/generated/models/create_upload_url_body.dart';
import '../../../core/api/generated/models/material.dart' as material_api;
import '../../../core/api/generated/models/toggle_ai_visible_body.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/domain/material_ready_state.dart';
import '../../student/presentation/widgets/material_ready_state_pill.dart';

/// Teacher-owned content for one class. Material rows are periodically refreshed while their
/// server-side scan or AI ingestion is active, so the transition to Ready is visible without
/// requiring the teacher to leave and return.
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

  void _refreshAssignments() =>
      setState(() => _assignments = _loadAssignments());
  void _refreshMaterials() {
    if (mounted) setState(() => _materials = _loadMaterials());
  }

  @override
  void dispose() {
    _materialRefresh?.cancel();
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.classCode),
      bottom: TabBar(
        controller: _tabs,
        tabs: const [
          Tab(text: 'Assignments'),
          Tab(text: 'Materials'),
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
        label: Text(_tabs.index == 0 ? 'Create assignment' : 'Upload material'),
        onPressed: () async {
          final changed = await Navigator.of(context).push<bool>(
            MaterialPageRoute(
              builder: (_) => _tabs.index == 0
                  ? _AssignmentComposer(classId: widget.classId)
                  : _MaterialComposer(classId: widget.classId),
            ),
          );
          if (changed == true) {
            _tabs.index == 0 ? _refreshAssignments() : _refreshMaterials();
          }
        },
      ),
    ),
    body: TabBarView(
      controller: _tabs,
      children: [
        _AssignmentList(future: _assignments, onRefresh: _refreshAssignments),
        _MaterialList(
          future: _materials,
          onRefresh: _refreshMaterials,
          onToggleAi: _toggleAi,
        ),
      ],
    ),
  );

  Future<void> _toggleAi(material_api.Material material, bool visible) async {
    try {
      await ref
          .read(apiClientProvider)
          .academics
          .toggleMaterialAiVisible(
            materialId: material.id,
            body: ToggleAiVisibleBody(aiVisible: visible),
          );
      _refreshMaterials();
    } on DioException catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not update AI visibility.')),
        );
      }
    }
  }
}

class _AssignmentList extends StatelessWidget {
  const _AssignmentList({required this.future, required this.onRefresh});
  final Future<List<Assignment>> future;
  final VoidCallback onRefresh;

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
          text: 'Could not load assignments.',
        );
      }
      final assignments = snapshot.data!;
      return RefreshIndicator(
        onRefresh: () async => onRefresh(),
        child: assignments.isEmpty
            ? const _Message(
                icon: Icons.assignment_outlined,
                text: 'No assignments yet.',
              )
            : ListView.separated(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(AppSpacing.space16),
                itemCount: assignments.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(height: AppSpacing.space8),
                itemBuilder: (_, index) {
                  final item = assignments[index];
                  return Card(
                    child: ListTile(
                      title: Text(item.title),
                      subtitle: Text(
                        'Due ${MaterialLocalizations.of(context).formatMediumDate(item.dueAt.toLocal())} · ${item.maxScore} points',
                      ),
                      trailing: item.attachments.isEmpty
                          ? null
                          : Badge(label: Text('${item.attachments.length}')),
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
    required this.onToggleAi,
  });
  final Future<List<material_api.Material>> future;
  final VoidCallback onRefresh;
  final Future<void> Function(material_api.Material, bool) onToggleAi;

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
        return const _Message(
          icon: Icons.error_outline,
          text: 'Could not load materials.',
        );
      }
      final materials = snapshot.data!;
      return RefreshIndicator(
        onRefresh: () async => onRefresh(),
        child: materials.isEmpty
            ? const _Message(
                icon: Icons.folder_open_outlined,
                text: 'No materials yet.',
              )
            : ListView.separated(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(AppSpacing.space16),
                itemCount: materials.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(height: AppSpacing.space8),
                itemBuilder: (_, index) {
                  final material = materials[index];
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
                          Text(
                            material.title,
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                          const SizedBox(height: AppSpacing.space4),
                          MaterialReadyStatePill(
                            state: materialReadyStateFromWireName(
                              material.ingestStatus.name,
                            ),
                          ),
                          SwitchListTile.adaptive(
                            contentPadding: EdgeInsets.zero,
                            title: const Text(
                              'Allow Studafy AI to use this material',
                            ),
                            subtitle: const Text(
                              'When on, its content can be processed for AI study tools.',
                            ),
                            value: material.aiVisible,
                            onChanged: (value) => onToggleAi(material, value),
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

class _LocalFile {
  const _LocalFile(this.path, this.name, this.sizeBytes);
  final String path;
  final String name;
  final int sizeBytes;
  String get contentType => lookupMimeType(path) ?? 'application/octet-stream';
}

class _AssignmentComposer extends ConsumerStatefulWidget {
  const _AssignmentComposer({required this.classId});
  final String classId;
  @override
  ConsumerState<_AssignmentComposer> createState() =>
      _AssignmentComposerState();
}

class _AssignmentComposerState extends ConsumerState<_AssignmentComposer> {
  final _formKey = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _details = TextEditingController();
  final _score = TextEditingController(text: '100');
  final List<_LocalFile> _attachments = [];
  DateTime _dueAt = DateTime.now().add(const Duration(days: 7));
  bool _lateAllowed = false;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _title.dispose();
    _details.dispose();
    _score.dispose();
    super.dispose();
  }

  Future<void> _pickFiles() async {
    final selected = await FilePicker.pickFiles(
      allowMultiple: true,
      withData: false,
    );
    if (selected == null) {
      return;
    }
    setState(
      () => _attachments.addAll(
        selected.files
            .where((f) => f.path != null)
            .map((f) => _LocalFile(f.path!, f.name, f.size)),
      ),
    );
  }

  Future<void> _pickDueDate() async {
    final date = await showDatePicker(
      context: context,
      initialDate: _dueAt,
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 3650)),
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

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final assignment = await ref
          .read(apiClientProvider)
          .assignments
          .createAssignment(
            body: CreateAssignmentBody(
              classId: widget.classId,
              title: _title.text.trim(),
              description: _details.text.trim().isEmpty
                  ? null
                  : _details.text.trim(),
              dueAt: _dueAt.toUtc(),
              maxScore: num.parse(_score.text),
              allowLateSubmission: _lateAllowed,
              status: CreateAssignmentBodyStatus.published,
            ),
          );
      for (final file in _attachments) {
        final upload = await ref
            .read(apiClientProvider)
            .assignments
            .createAssignmentAttachmentUploadUrl(
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
        await ref
            .read(apiClientProvider)
            .assignments
            .confirmAssignmentAttachment(
              assignmentId: assignment.id,
              body: ConfirmAttachmentBody(storageKey: upload.storageKey),
            );
      }
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (error) {
      setState(() => _error = error.message ?? 'Could not create assignment.');
    } catch (_) {
      setState(() => _error = 'Could not create assignment.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Create assignment')),
    body: Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: [
          TextFormField(
            controller: _title,
            decoration: const InputDecoration(labelText: 'Title'),
            validator: (v) =>
                v == null || v.trim().isEmpty ? 'Enter a title.' : null,
          ),
          const SizedBox(height: AppSpacing.space12),
          TextFormField(
            controller: _details,
            decoration: const InputDecoration(
              labelText: 'Instructions (optional)',
            ),
            minLines: 3,
            maxLines: 6,
          ),
          const SizedBox(height: AppSpacing.space12),
          TextFormField(
            controller: _score,
            decoration: const InputDecoration(labelText: 'Points'),
            keyboardType: TextInputType.number,
            validator: (v) =>
                num.tryParse(v ?? '') == null ? 'Enter valid points.' : null,
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Due date'),
            subtitle: Text(
              MaterialLocalizations.of(context).formatFullDate(_dueAt),
            ),
            trailing: const Icon(Icons.calendar_today_outlined),
            onTap: _pickDueDate,
          ),
          SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            title: const Text('Allow late submissions'),
            value: _lateAllowed,
            onChanged: (v) => setState(() => _lateAllowed = v),
          ),
          OutlinedButton.icon(
            onPressed: _saving ? null : _pickFiles,
            icon: const Icon(Icons.attach_file),
            label: const Text('Add attachments'),
          ),
          for (final file in _attachments)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.insert_drive_file_outlined),
              title: Text(file.name),
              trailing: IconButton(
                icon: const Icon(Icons.close),
                onPressed: _saving
                    ? null
                    : () => setState(() => _attachments.remove(file)),
              ),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.space12),
              child: Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          const SizedBox(height: AppSpacing.space24),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const CircularProgressIndicator()
                : const Text('Publish assignment'),
          ),
        ],
      ),
    ),
  );
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
  _LocalFile? _file;
  bool _aiVisible = false;
  bool _uploading = false;
  double? _progress;
  String? _error;
  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  Future<void> _chooseFile() async {
    final result = await FilePicker.pickFiles(withData: false);
    if (result?.files.single.path != null) {
      setState(() {
        final file = result!.files.single;
        _file = _LocalFile(file.path!, file.name, file.size);
        _title.text = _title.text.isEmpty ? file.name : _title.text;
      });
    }
  }

  Future<void> _takePhoto() async {
    final image = await ImagePicker().pickImage(source: ImageSource.camera);
    if (image != null) {
      final size = await File(image.path).length();
      setState(() {
        _file = _LocalFile(image.path, image.name, size);
        _title.text = _title.text.isEmpty ? image.name : _title.text;
      });
    }
  }

  Future<void> _upload() async {
    if (!_formKey.currentState!.validate() || _file == null) {
      setState(() => _error = 'Choose a file or take a photo.');
      return;
    }
    final file = _file!;
    setState(() {
      _uploading = true;
      _progress = 0;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final upload = await api.academics.initiateMaterialUpload(
        body: CreateMaterialBody(
          classId: widget.classId,
          title: _title.text.trim(),
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
      var material = await api.academics.confirmMaterialUpload(
        materialId: pending.id,
        body: ConfirmUploadBody(storageKey: upload.storageKey),
      );
      if (_aiVisible && !material.aiVisible) {
        material = await api.academics.toggleMaterialAiVisible(
          materialId: material.id,
          body: const ToggleAiVisibleBody(aiVisible: true),
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (error) {
      setState(() => _error = error.message ?? 'Upload failed.');
    } catch (_) {
      setState(() => _error = 'Upload failed.');
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Upload material')),
    body: Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.space16),
        children: [
          TextFormField(
            controller: _title,
            decoration: const InputDecoration(labelText: 'Title'),
            validator: (v) =>
                v == null || v.trim().isEmpty ? 'Enter a title.' : null,
          ),
          const SizedBox(height: AppSpacing.space12),
          Wrap(
            spacing: AppSpacing.space8,
            children: [
              OutlinedButton.icon(
                onPressed: _uploading ? null : _chooseFile,
                icon: const Icon(Icons.upload_file_outlined),
                label: const Text('Choose file'),
              ),
              OutlinedButton.icon(
                onPressed: _uploading ? null : _takePhoto,
                icon: const Icon(Icons.camera_alt_outlined),
                label: const Text('Camera'),
              ),
            ],
          ),
          if (_file != null)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.insert_drive_file_outlined),
              title: Text(_file!.name),
            ),
          SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            title: const Text('Allow Studafy AI to use this material'),
            subtitle: const Text(
              'When on, its content can be processed for AI study tools.',
            ),
            value: _aiVisible,
            onChanged: _uploading
                ? null
                : (v) => setState(() => _aiVisible = v),
          ),
          if (_uploading)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.space12),
              child: LinearProgressIndicator(value: _progress),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.space12),
              child: Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          const SizedBox(height: AppSpacing.space24),
          FilledButton(
            onPressed: _uploading ? null : _upload,
            child: Text(_uploading ? 'Uploading…' : 'Upload material'),
          ),
        ],
      ),
    ),
  );
}
