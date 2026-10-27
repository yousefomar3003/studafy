import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/academic_results_providers.dart';
import '../application/student_context_providers.dart';
import '../domain/academic_results.dart';
import 'certificate_detail_screen.dart';
import 'widgets/academic_result_widgets.dart';

/// A student's official, finalized results — by academic year, each term report and the annual
/// result with its overall standing (promoted / supplementary / retained / incomplete) and subject
/// table — followed by their certificates and report cards, each opening
/// [CertificateDetailScreen].
///
/// Shared by both audiences: the student opens it with no [studentId] (resolved from
/// `currentStudentIdProvider`, i.e. `GET /api/students/me`); a parent opens it for the child
/// selected on the Children tab. The API only serves a student their own results and a parent
/// their linked children's.
class AcademicResultsScreen extends ConsumerWidget {
  const AcademicResultsScreen({this.studentId, this.studentName, super.key});

  /// Whose results to show. Null = the signed-in student.
  final String? studentId;

  /// Shown under the title (a parent's child name).
  final String? studentName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = studentId ?? ref.watch(currentStudentIdProvider);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('academicResults.title'.tr()),
            if (studentName != null)
              Text(studentName!, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
      body: id == null
          ? (studentId == null &&
                    ref.watch(currentStudentSelfProvider).isLoading
                ? const Center(child: CircularProgressIndicator())
                : _Message(
                    icon: Icons.info_outline,
                    message: 'academicResults.unavailable'.tr(),
                  ))
          : _ResultsBody(studentId: id),
    );
  }
}

class _ResultsBody extends ConsumerWidget {
  const _ResultsBody({required this.studentId});

  final String studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final results = ref.watch(studentResultsProvider(studentId));
    final certificates = ref.watch(studentCertificatesProvider(studentId));

    return RefreshIndicator(
      onRefresh: () async {
        ref
          ..invalidate(studentResultsProvider(studentId))
          ..invalidate(studentCertificatesProvider(studentId));
        await ref.read(studentResultsProvider(studentId).future);
      },
      child: results.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => _Message(
          icon: Icons.error_outline,
          message: 'academicResults.error'.tr(),
          onRetry: () => ref.invalidate(studentResultsProvider(studentId)),
        ),
        data: (list) {
          final termNames = {
            for (final result in list)
              if (result.termId != null && result.termName != null)
                result.termId!: result.termName!,
          };
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            children: [
              if (list.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: AppSpacing.space24,
                  ),
                  child: Text(
                    'academicResults.empty'.tr(),
                    textAlign: TextAlign.center,
                  ),
                ),
              for (final year in groupResultsByYear(list)) ...[
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                  child: Text(
                    year.yearName,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                for (final result in year.results)
                  _ResultCard(result: result, termNames: termNames),
                const SizedBox(height: AppSpacing.space8),
              ],
              const SizedBox(height: AppSpacing.space8),
              Text(
                'academicResults.certificates'.tr(),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.space8),
              ...certificates.when(
                loading: () => const [
                  Padding(
                    padding: EdgeInsets.all(AppSpacing.space16),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                ],
                error: (_, _) => [
                  Text('academicResults.certificatesError'.tr()),
                ],
                data: (docs) => docs.isEmpty
                    ? [Text('academicResults.certificatesEmpty'.tr())]
                    : [
                        for (final doc in docs)
                          _CertificateTile(certificate: doc),
                      ],
              ),
            ],
          );
        },
      ),
    );
  }
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.result, required this.termNames});

  final FinalizedResult result;
  final Map<String, String> termNames;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final finalizedAt = result.finalizedAt;
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              result.termName ?? 'academicResults.annual'.tr(),
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(
              [
                'academicResults.sectionLine'.tr(
                  namedArgs: {
                    'grade': result.gradeLevelName,
                    'section': result.sectionName,
                  },
                ),
                if (finalizedAt != null)
                  'academicResults.finalizedOn'.tr(
                    namedArgs: {
                      'date': DateFormat.yMMMd(
                        context.locale.toString(),
                      ).format(finalizedAt.toLocal()),
                    },
                  ),
                if (result.version > 1)
                  'academicResults.version'.tr(
                    namedArgs: {'version': '${result.version}'},
                  ),
              ].join(' · '),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            OverallResultSummary(overall: result.overall),
            if (result.subjects.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.space12),
              Theme(
                data: theme.copyWith(dividerColor: Colors.transparent),
                child: ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: EdgeInsets.zero,
                  initiallyExpanded: true,
                  title: Text(
                    'academicResults.subjects'.tr(),
                    style: theme.textTheme.titleSmall,
                  ),
                  children: [
                    SubjectResultsTable(
                      subjects: result.subjects,
                      termNames: result.isAnnual ? termNames : const {},
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _CertificateTile extends StatelessWidget {
  const _CertificateTile({required this.certificate});

  final AcademicCertificate certificate;

  @override
  Widget build(BuildContext context) {
    final content = certificate.content;
    final issuedAt = certificate.issuedAt;
    final title = [
      certificateKindLabel(certificate.kind),
      content.academicYearName,
      ?content.termName,
    ].where((part) => part.isNotEmpty).join(' · ');

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: ListTile(
        leading: Icon(
          certificate.isTermReport
              ? Icons.description_outlined
              : Icons.workspace_premium_outlined,
        ),
        title: Text(title),
        subtitle: Text(
          [
            'academicResults.serial'.tr(
              namedArgs: {'serial': certificate.serialNumber},
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
        trailing: CertificateStatusPill(status: certificate.status),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) =>
                CertificateDetailScreen(certificateId: certificate.id),
          ),
        ),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.message, this.onRetry});

  final IconData icon;
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.space32),
      children: [
        Icon(icon, size: 32, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(height: AppSpacing.space12),
        Text(
          message,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        if (onRetry != null) ...[
          const SizedBox(height: AppSpacing.space12),
          Center(
            child: OutlinedButton(
              onPressed: onRetry,
              child: Text('academicResults.retry'.tr()),
            ),
          ),
        ],
      ],
    );
  }
}
