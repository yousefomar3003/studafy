import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/transcript_providers.dart';
import '../domain/academic_results.dart';
import '../domain/transcript.dart';
import 'widgets/academic_result_widgets.dart';
import 'widgets/status_pill.dart';

/// One academic transcript, rendered from its stored `content` — every covered year (grade,
/// section, subjects, the year's overall result) and the cumulative average and GPA, exactly as
/// issued. A replaced or revoked transcript stays viewable but is flagged as no longer valid; a
/// valid one whose results changed since says the school will issue an updated one.
class TranscriptDetailScreen extends ConsumerWidget {
  const TranscriptDetailScreen({required this.transcriptId, super.key});

  final String transcriptId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final transcript = ref.watch(academicTranscriptProvider(transcriptId));

    return Scaffold(
      appBar: AppBar(title: Text('academicResults.transcript.title'.tr())),
      body: transcript.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.space32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'academicResults.certificate.error'.tr(),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.space12),
                OutlinedButton(
                  onPressed: () =>
                      ref.invalidate(academicTranscriptProvider(transcriptId)),
                  child: Text('academicResults.retry'.tr()),
                ),
              ],
            ),
          ),
        ),
        data: (doc) => _Document(transcript: doc),
      ),
    );
  }
}

class _Document extends StatelessWidget {
  const _Document({required this.transcript});

  final AcademicTranscript transcript;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final content = transcript.content;
    final cumulative = content.cumulative;
    final locale = context.locale.toString();
    String date(DateTime? value) =>
        value == null ? '—' : DateFormat.yMMMd(locale).format(value.toLocal());
    final invalid = !transcript.status.isValid;
    final revokeReason = transcript.revokeReason?.trim();
    final gpaReason = cumulative.gpaUnavailableReason;

    return ListView(
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        if (transcript.status == CertificateStatus.superseded) ...[
          ResultNotice(
            icon: Icons.history,
            tone: StatusPillTone.warning,
            lines: ['academicResults.certificate.supersededBanner'.tr()],
          ),
          const SizedBox(height: AppSpacing.space12),
        ],
        if (transcript.status == CertificateStatus.revoked) ...[
          ResultNotice(
            icon: Icons.block,
            tone: StatusPillTone.danger,
            lines: [
              'academicResults.certificate.revokedBanner'.tr(),
              if (transcript.revokedAt != null)
                'academicResults.certificate.revokedOn'.tr(
                  namedArgs: {'date': date(transcript.revokedAt)},
                ),
              if (revokeReason != null && revokeReason.isNotEmpty)
                'academicResults.certificate.reason'.tr(
                  namedArgs: {'reason': revokeReason},
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.space12),
        ],
        if (!invalid && transcript.needsReissue) ...[
          ResultNotice(
            icon: Icons.info_outline,
            tone: StatusPillTone.neutral,
            lines: ['academicResults.transcript.needsReissue'.tr()],
          ),
          const SizedBox(height: AppSpacing.space12),
        ],
        Opacity(
          opacity: invalid ? 0.6 : 1,
          child: Card(
            margin: EdgeInsets.zero,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: BorderSide(color: theme.colorScheme.outlineVariant),
            ),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    content.schoolName,
                    textAlign: TextAlign.center,
                    style: theme.textTheme.titleLarge,
                  ),
                  const SizedBox(height: AppSpacing.space4),
                  Text(
                    'academicResults.transcript.title'.tr(),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.titleMedium,
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  Center(
                    child: CertificateStatusPill(status: transcript.status),
                  ),
                  const Divider(height: AppSpacing.space32),
                  _Field(
                    label: 'academicResults.certificate.student'.tr(),
                    value: content.studentName,
                  ),
                  _Field(
                    label: 'academicResults.certificate.admission'.tr(),
                    value: content.admissionNumber,
                  ),
                  for (final year in content.years) ...[
                    const Divider(height: AppSpacing.space32),
                    Text(
                      year.academicYearName,
                      style: theme.textTheme.titleSmall,
                    ),
                    Text(
                      'academicResults.sectionLine'.tr(
                        namedArgs: {
                          'grade': year.gradeLevelName,
                          'section': year.sectionName,
                        },
                      ),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.space8),
                    SubjectResultsTable(subjects: year.subjects),
                    const SizedBox(height: AppSpacing.space8),
                    OverallResultSummary(overall: year.overall),
                  ],
                  const Divider(height: AppSpacing.space32),
                  Text(
                    'academicResults.transcript.cumulative'.tr(),
                    style: theme.textTheme.titleSmall,
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  _Field(
                    label: 'academicResults.transcript.cumulativeAverage'.tr(),
                    value: formatResultPercent(cumulative.averagePercentage),
                  ),
                  _Field(
                    label: 'academicResults.transcript.cumulativeGpa'.tr(),
                    value: cumulative.gpa == null
                        ? '—'
                        : formatResultNumber(cumulative.gpa!),
                  ),
                  _Field(
                    label: 'academicResults.transcript.yearsCovered'.tr(),
                    value: '${cumulative.yearsCovered}',
                  ),
                  if (cumulative.gpa == null && gpaReason != null)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.space4),
                      child: Text(
                        'academicResults.transcript.gpaReason.${gpaReason.name}'
                            .tr(
                              namedArgs: {
                                'subjects': cumulative.subjectsWithoutGpaPoints
                                    .join(', '),
                                'scales': cumulative.mixedGpaScales
                                    .map(
                                      (scale) =>
                                          'academicResults.transcript.gpaScale'
                                              .tr(
                                                namedArgs: {
                                                  'year': scale.year,
                                                  'max': formatResultNumber(
                                                    scale.max,
                                                  ),
                                                },
                                              ),
                                    )
                                    .join(', '),
                              },
                            ),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  const Divider(height: AppSpacing.space32),
                  _Field(
                    label: 'academicResults.certificate.serialLabel'.tr(),
                    value: content.serialNumber,
                  ),
                  _Field(
                    label: 'academicResults.certificate.issueDate'.tr(),
                    value: date(content.issuedAt),
                  ),
                  if (content.issuedByName != null)
                    _Field(
                      label: 'academicResults.certificate.issuedBy'.tr(),
                      value: content.issuedByName!,
                    ),
                  if (content.reissueOfSerial != null) ...[
                    const SizedBox(height: AppSpacing.space8),
                    Text(
                      'academicResults.certificate.reissueOf'.tr(
                        namedArgs: {'serial': content.reissueOfSerial!},
                      ),
                      style: theme.textTheme.bodySmall,
                    ),
                    if (content.reissueReason?.trim().isNotEmpty ?? false)
                      Text(
                        'academicResults.certificate.reason'.tr(
                          namedArgs: {'reason': content.reissueReason!.trim()},
                        ),
                        style: theme.textTheme.bodySmall,
                      ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 2,
            child: Text(
              label,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            flex: 3,
            child: Text(
              value.isEmpty ? '—' : value,
              style: theme.textTheme.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }
}
