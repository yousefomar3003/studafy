import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/create_incident_body.dart';
import '../../../core/api/generated/models/create_incident_body_incident_type.dart';
import '../../../core/api/generated/models/create_incident_body_severity.dart';
import '../../../core/api/generated/models/discipline_incident.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/teacher_providers.dart';
import '../domain/teacher_communication.dart';

/// Files a discipline incident against a student in one of the signed-in teacher's classes.
///
/// Pushed from the class-detail AppBar, so it owns its [Scaffold]. The incident is created with
/// status `reported` and routes straight into the Principal workflow — a teacher can file and
/// read their own reports but cannot triage, action, or resolve them (the API withholds
/// `discipline:incident:update` / `:resolve` from INSTRUCTOR). On success it pops with the
/// created [DisciplineIncident].
class IncidentReportScreen extends ConsumerStatefulWidget {
  const IncidentReportScreen({
    required this.classId,
    required this.classCode,
    this.initialStudentId,
    super.key,
  });

  final String classId;
  final String classCode;

  /// Preselects a roster student when the form is opened for a specific one.
  final String? initialStudentId;

  @override
  ConsumerState<IncidentReportScreen> createState() => _IncidentReportScreenState();
}

class _IncidentReportScreenState extends ConsumerState<IncidentReportScreen> {
  final _formKey = GlobalKey<FormState>();
  final _titleController = TextEditingController();
  final _descriptionController = TextEditingController();

  String? _studentId;
  CreateIncidentBodyIncidentType _type = incidentTypeOptions.first;
  CreateIncidentBodySeverity _severity = CreateIncidentBodySeverity.minor;
  late DateTime _occurredAt;

  bool _submitting = false;
  String? _errorKey;

  @override
  void initState() {
    super.initState();
    _studentId = widget.initialStudentId;
    _occurredAt = DateTime.now();
  }

  @override
  void dispose() {
    _titleController.dispose();
    _descriptionController.dispose();
    super.dispose();
  }

  Future<void> _pickOccurredAt() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: _occurredAt,
      firstDate: now.subtract(const Duration(days: 365)),
      lastDate: now,
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_occurredAt),
    );
    if (!mounted) return;
    final picked = DateTime(
      date.year,
      date.month,
      date.day,
      time?.hour ?? _occurredAt.hour,
      time?.minute ?? _occurredAt.minute,
    );
    // Guard the "today, but a future clock time" corner the pickers still allow.
    setState(() => _occurredAt = picked.isAfter(now) ? now : picked);
  }

  Future<void> _submit() async {
    final studentId = _studentId;
    if (_submitting || studentId == null || !(_formKey.currentState?.validate() ?? false)) {
      if (studentId == null) {
        setState(() => _errorKey = 'teacher.communication.incident.studentRequired');
      }
      return;
    }

    setState(() {
      _submitting = true;
      _errorKey = null;
    });

    try {
      final description = _descriptionController.text.trim();
      final incident = await ref.read(apiClientProvider).discipline.createDisciplineIncident(
            body: CreateIncidentBody(
              studentId: studentId,
              classId: widget.classId,
              incidentType: _type,
              severity: _severity,
              title: _titleController.text.trim(),
              description: description.isEmpty ? null : description,
              incidentAt: _occurredAt.toUtc(),
            ),
          );
      if (mounted) Navigator.of(context).pop(incident);
    } on DioException catch (error) {
      setState(() => _errorKey = _messageKeyFor(error.apiError?.code));
    } catch (_) {
      setState(() => _errorKey = 'teacher.communication.incident.errorGeneric');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  String _messageKeyFor(String? code) => switch (code) {
        'AUTHZ_FORBIDDEN' => 'teacher.communication.incident.errorForbidden',
        'VALIDATION_FAILED' => 'teacher.communication.incident.errorValidation',
        _ => 'teacher.communication.incident.errorGeneric',
      };

  String _studentLabel(String studentId) {
    final name = ref.watch(rosterStudentNameProvider(studentId));
    if (name != null) return name;
    final shortId =
        studentId.length <= 6 ? studentId : studentId.substring(studentId.length - 6);
    return 'teacher.class.unknownStudent'.tr(namedArgs: {'id': shortId});
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final roster = ref.watch(classRosterProvider(widget.classId));

    return Scaffold(
      appBar: AppBar(title: Text('teacher.communication.incident.title'.tr())),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.space16),
          children: [
            Text(
              'teacher.communication.incident.routing'.tr(),
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space16),
            roster.when(
              loading: () => const Center(
                child: Padding(
                  padding: EdgeInsets.symmetric(vertical: AppSpacing.space16),
                  child: CircularProgressIndicator(),
                ),
              ),
              error: (_, _) => Text(
                'teacher.class.rosterError'.tr(),
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: theme.colorScheme.error),
              ),
              data: (enrollments) => DropdownButtonFormField<String>(
                initialValue: enrollments.any((e) => e.studentId == _studentId)
                    ? _studentId
                    : null,
                decoration: InputDecoration(
                  labelText: 'teacher.communication.incident.studentField'.tr(),
                ),
                items: [
                  for (final enrollment in enrollments)
                    DropdownMenuItem(
                      value: enrollment.studentId,
                      child: Text(_studentLabel(enrollment.studentId)),
                    ),
                ],
                onChanged: (value) => setState(() => _studentId = value),
                validator: (value) => value == null
                    ? 'teacher.communication.incident.studentRequired'.tr()
                    : null,
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            DropdownButtonFormField<CreateIncidentBodyIncidentType>(
              initialValue: _type,
              decoration: InputDecoration(
                labelText: 'teacher.communication.incident.typeField'.tr(),
              ),
              items: [
                for (final type in incidentTypeOptions)
                  DropdownMenuItem(
                    value: type,
                    child: Text(incidentTypeLabelKey(type).tr()),
                  ),
              ],
              onChanged: (value) =>
                  setState(() => _type = value ?? _type),
            ),
            const SizedBox(height: AppSpacing.space12),
            DropdownButtonFormField<CreateIncidentBodySeverity>(
              initialValue: _severity,
              decoration: InputDecoration(
                labelText: 'teacher.communication.incident.severityField'.tr(),
              ),
              items: [
                for (final severity in incidentSeverityOptions)
                  DropdownMenuItem(
                    value: severity,
                    child: Text(incidentSeverityLabelKey(severity).tr()),
                  ),
              ],
              onChanged: (value) =>
                  setState(() => _severity = value ?? _severity),
            ),
            const SizedBox(height: AppSpacing.space12),
            TextFormField(
              controller: _titleController,
              textCapitalization: TextCapitalization.sentences,
              maxLength: 200,
              decoration: InputDecoration(
                labelText: 'teacher.communication.incident.summaryField'.tr(),
              ),
              validator: (value) => (value == null || value.trim().isEmpty)
                  ? 'teacher.communication.incident.summaryRequired'.tr()
                  : null,
            ),
            const SizedBox(height: AppSpacing.space8),
            TextFormField(
              controller: _descriptionController,
              textCapitalization: TextCapitalization.sentences,
              minLines: 3,
              maxLines: 8,
              decoration: InputDecoration(
                labelText: 'teacher.communication.incident.detailField'.tr(),
              ),
            ),
            const SizedBox(height: AppSpacing.space4),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('teacher.communication.incident.occurredAt'.tr()),
              subtitle: Builder(
                builder: (context) {
                  final l10n = MaterialLocalizations.of(context);
                  final date = l10n.formatFullDate(_occurredAt);
                  final time =
                      l10n.formatTimeOfDay(TimeOfDay.fromDateTime(_occurredAt));
                  return Text('$date · $time');
                },
              ),
              trailing: const Icon(Icons.event_outlined),
              onTap: _submitting ? null : _pickOccurredAt,
            ),
            if (_errorKey != null) ...[
              const SizedBox(height: AppSpacing.space8),
              Text(
                _errorKey!.tr(),
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.error),
              ),
            ],
            const SizedBox(height: AppSpacing.space20),
            FilledButton(
              onPressed: _submitting ? null : _submit,
              child: _submitting
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text('teacher.communication.incident.submit'.tr()),
            ),
          ],
        ),
      ),
    );
  }
}
