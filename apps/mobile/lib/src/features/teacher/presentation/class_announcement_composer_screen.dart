import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/announcement.dart';
import '../../../core/api/generated/models/create_announcement_body.dart';
import '../../../core/api/generated/models/create_announcement_body_audience_type.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../design/tokens/app_spacing_tokens.dart';

/// Composes a class announcement for one class the signed-in teacher leads.
///
/// Pushed from the class-detail AppBar, so it owns its [Scaffold]. The audience is fixed to
/// [classId] — a teacher's compose surface is deliberately "this class only, opt-outable" (the
/// server enforces the same via the scoped `notification:send` path, ST-238), so there is no
/// audience picker and no mandatory toggle. On success it pops with the created [Announcement]
/// so the caller can report the resolved reach.
class ClassAnnouncementComposerScreen extends ConsumerStatefulWidget {
  const ClassAnnouncementComposerScreen({
    required this.classId,
    required this.classCode,
    super.key,
  });

  final String classId;
  final String classCode;

  @override
  ConsumerState<ClassAnnouncementComposerScreen> createState() =>
      _ClassAnnouncementComposerScreenState();
}

class _ClassAnnouncementComposerScreenState
    extends ConsumerState<ClassAnnouncementComposerScreen> {
  final _formKey = GlobalKey<FormState>();
  final _titleController = TextEditingController();
  final _bodyController = TextEditingController();

  bool _sending = false;
  String? _errorKey;

  @override
  void dispose() {
    _titleController.dispose();
    _bodyController.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_sending || !(_formKey.currentState?.validate() ?? false)) return;

    setState(() {
      _sending = true;
      _errorKey = null;
    });

    try {
      final announcement =
          await ref.read(apiClientProvider).announcements.createAnnouncement(
                body: CreateAnnouncementBody(
                  title: _titleController.text.trim(),
                  body: _bodyController.text.trim(),
                  mandatory: false,
                  audienceType: CreateAnnouncementBodyAudienceType.valueClass,
                  audienceClassId: widget.classId,
                ),
              );
      if (mounted) Navigator.of(context).pop(announcement);
    } on DioException catch (error) {
      setState(() => _errorKey = _messageKeyFor(error.apiError?.code));
    } catch (_) {
      setState(() => _errorKey = 'teacher.communication.announce.errorGeneric');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  String _messageKeyFor(String? code) => switch (code) {
        'ANNOUNCEMENT_SCOPE_FORBIDDEN' ||
        'AUTHZ_FORBIDDEN' =>
          'teacher.communication.announce.errorForbidden',
        'VALIDATION_FAILED' => 'teacher.communication.announce.errorValidation',
        _ => 'teacher.communication.announce.errorGeneric',
      };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: Text('teacher.communication.announce.title'.tr())),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.space16),
          children: [
            Text(
              'teacher.communication.announce.audience'
                  .tr(namedArgs: {'class': widget.classCode}),
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space16),
            TextFormField(
              controller: _titleController,
              autofocus: true,
              textCapitalization: TextCapitalization.sentences,
              maxLength: 200,
              decoration: InputDecoration(
                labelText: 'teacher.communication.announce.titleField'.tr(),
              ),
              validator: (value) => (value == null || value.trim().isEmpty)
                  ? 'teacher.communication.announce.titleRequired'.tr()
                  : null,
            ),
            const SizedBox(height: AppSpacing.space8),
            TextFormField(
              controller: _bodyController,
              textCapitalization: TextCapitalization.sentences,
              minLines: 4,
              maxLines: 10,
              maxLength: 5000,
              decoration: InputDecoration(
                labelText: 'teacher.communication.announce.bodyField'.tr(),
              ),
              validator: (value) => (value == null || value.trim().isEmpty)
                  ? 'teacher.communication.announce.bodyRequired'.tr()
                  : null,
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
              onPressed: _sending ? null : _send,
              child: _sending
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text('teacher.communication.announce.submit'.tr()),
            ),
          ],
        ),
      ),
    );
  }
}
