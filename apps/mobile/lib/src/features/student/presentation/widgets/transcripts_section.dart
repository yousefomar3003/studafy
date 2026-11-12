import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/transcript_providers.dart';
import '../../domain/transcript.dart';
import '../transcript_detail_screen.dart';
import 'academic_result_widgets.dart';

/// The "Transcripts" block of the results screen: every transcript the school issued for the
/// student, newest first, each opening [TranscriptDetailScreen]. A student without one sees a
/// short explanation; the school issues transcripts, nobody requests them here.
class TranscriptsSection extends ConsumerWidget {
  const TranscriptsSection({required this.studentId, super.key});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final transcripts = ref.watch(studentTranscriptsProvider(studentId));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'academicResults.transcripts'.tr(),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: AppSpacing.space8),
        ...transcripts.when(
          loading: () => const [
            Padding(
              padding: EdgeInsets.all(AppSpacing.space16),
              child: Center(child: CircularProgressIndicator()),
            ),
          ],
          error: (_, _) => [Text('academicResults.transcriptsError'.tr())],
          data: (docs) => docs.isEmpty
              ? [Text('academicResults.transcriptsEmpty'.tr())]
              : [for (final doc in docs) _TranscriptTile(transcript: doc)],
        ),
      ],
    );
  }
}

class _TranscriptTile extends StatelessWidget {
  const _TranscriptTile({required this.transcript});

  final AcademicTranscript transcript;

  @override
  Widget build(BuildContext context) {
    final issuedAt = transcript.issuedAt;
    final years = transcript.content.years;
    final span = years.isEmpty
        ? null
        : years.length == 1
        ? years.first.academicYearName
        : '${years.first.academicYearName} – ${years.last.academicYearName}';
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: ListTile(
        leading: const Icon(Icons.history_edu_outlined),
        title: Text(
          ['academicResults.transcript.title'.tr(), ?span].join(' · '),
        ),
        subtitle: Text(
          [
            'academicResults.serial'.tr(
              namedArgs: {'serial': transcript.serialNumber},
            ),
            if (issuedAt != null)
              'academicResults.issuedOn'.tr(
                namedArgs: {
                  'date': DateFormat.yMMMd(
                    context.locale.toString(),
                  ).format(issuedAt.toLocal()),
                },
              ),
          ].join('\n'),
        ),
        isThreeLine: issuedAt != null,
        trailing: CertificateStatusPill(status: transcript.status),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => TranscriptDetailScreen(transcriptId: transcript.id),
          ),
        ),
      ),
    );
  }
}
