import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/academic_results_providers.dart';
import '../domain/academic_results.dart';
import 'widgets/academic_result_widgets.dart';
import 'widgets/status_pill.dart';

/// One certificate or report card, rendered from its stored `content` — the document exactly as
/// issued (school, year, student, section, subjects, overall, serial number, issue date, issuer,
/// reissue details), never recomputed from current results.
///
/// A superseded or revoked document stays viewable but is flagged prominently as no longer valid
/// (with the revocation date and reason); a valid one whose results were corrected since says a
/// reissue is due.
class CertificateDetailScreen extends ConsumerWidget {
  const CertificateDetailScreen({required this.certificateId, super.key});

  final String certificateId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final certificate = ref.watch(academicCertificateProvider(certificateId));
    final loaded = certificate.value;

    return Scaffold(
      appBar: AppBar(
        title: Text(
          loaded == null
              ? 'academicResults.certificates'.tr()
              : certificateKindLabel(loaded.kind),
        ),
      ),
      body: certificate.when(
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
                  onPressed: () => ref.invalidate(
                    academicCertificateProvider(certificateId),
                  ),
                  child: Text('academicResults.retry'.tr()),
                ),
              ],
            ),
          ),
        ),
        data: (doc) => _Document(certificate: doc),
      ),
    );
  }
}

class _Document extends StatelessWidget {
  const _Document({required this.certificate});

  final AcademicCertificate certificate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final content = certificate.content;
    final locale = context.locale.toString();
    String date(DateTime? value) =>
        value == null ? '—' : DateFormat.yMMMd(locale).format(value.toLocal());

    final invalid = !certificate.status.isValid;
    final revokeReason = certificate.revokeReason?.trim();

    return ListView(
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        if (certificate.status == CertificateStatus.superseded) ...[
          ResultNotice(
            icon: Icons.history,
            tone: StatusPillTone.warning,
            lines: ['academicResults.certificate.supersededBanner'.tr()],
          ),
          const SizedBox(height: AppSpacing.space12),
        ],
        if (certificate.status == CertificateStatus.revoked) ...[
          ResultNotice(
            icon: Icons.block,
            tone: StatusPillTone.danger,
            lines: [
              'academicResults.certificate.revokedBanner'.tr(),
              if (certificate.revokedAt != null)
                'academicResults.certificate.revokedOn'.tr(
                  namedArgs: {'date': date(certificate.revokedAt)},
                ),
              if (revokeReason != null && revokeReason.isNotEmpty)
                'academicResults.certificate.reason'.tr(
                  namedArgs: {'reason': revokeReason},
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.space12),
        ],
        if (!invalid && certificate.needsReissue) ...[
          ResultNotice(
            icon: Icons.info_outline,
            tone: StatusPillTone.neutral,
            lines: ['academicResults.certificate.needsReissue'.tr()],
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
                    [
                      certificateKindLabel(content.kind),
                      content.academicYearName,
                      ?content.termName,
                    ].where((part) => part.isNotEmpty).join(' · '),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.titleMedium,
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  Center(
                    child: CertificateStatusPill(status: certificate.status),
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
                  _Field(
                    label: 'academicResults.certificate.section'.tr(),
                    value: 'academicResults.sectionLine'.tr(
                      namedArgs: {
                        'grade': content.gradeLevelName,
                        'section': content.sectionName,
                      },
                    ),
                  ),
                  _Field(
                    label: 'academicResults.certificate.year'.tr(),
                    value: content.academicYearName,
                  ),
                  if (content.termName != null)
                    _Field(
                      label: 'academicResults.certificate.term'.tr(),
                      value: content.termName!,
                    ),
                  const SizedBox(height: AppSpacing.space16),
                  Text(
                    'academicResults.subjects'.tr(),
                    style: theme.textTheme.titleSmall,
                  ),
                  const SizedBox(height: AppSpacing.space4),
                  SubjectResultsTable(subjects: content.subjects),
                  const SizedBox(height: AppSpacing.space16),
                  Text(
                    'academicResults.certificate.overall'.tr(),
                    style: theme.textTheme.titleSmall,
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  OverallResultSummary(overall: content.overall),
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
                  if (content.finalizationVersion != null)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.space4),
                      child: Text(
                        'academicResults.certificate.finalization'.tr(
                          namedArgs: {
                            'version': '${content.finalizationVersion}',
                            'date': date(content.finalizedAt),
                          },
                        ),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
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
