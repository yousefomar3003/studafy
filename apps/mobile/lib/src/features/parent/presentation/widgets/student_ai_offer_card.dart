import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../shell/application/shell_providers.dart';
import '../../application/student_ai_providers.dart';
import '../../domain/student_ai_offer.dart';

/// The status label for a child's Student AI: on the home card and on each offer card.
({String labelKey, AppTone tone}) studentAiStatusOf(StudentAiOffer offer) {
  final optIn = offer.optIn;
  if (optIn != null && !optIn.isActive) {
    return (labelKey: 'studentAiOptIn.status.ended', tone: AppTone.neutral);
  }
  if (optIn != null || offer.state == StudentAiOfferState.optedIn) {
    return optIn?.waitingForSeat ?? false
        ? (labelKey: 'studentAiOptIn.status.waitingSeat', tone: AppTone.warning)
        : (labelKey: 'studentAiOptIn.status.confirmed', tone: AppTone.success);
  }
  if (offer.canOptIn) {
    return (labelKey: 'studentAiOptIn.status.available', tone: AppTone.brand);
  }
  return (labelKey: 'studentAiOptIn.status.closed', tone: AppTone.neutral);
}

/// Student AI for one child: the school's offer -- what it includes, the commitment and the
/// confirmation -- while the school's window is open; what was confirmed once it is (no cancel: it
/// is committed for the school year); or that joining is closed at the school for now.
///
/// Never a price, a total or a way to pay: Student AI is part of the school fees and the school
/// tells parents the price (store rules; `test/store_compliance/payment_routing_test.dart`).
class StudentAiOfferCard extends ConsumerWidget {
  const StudentAiOfferCard({required this.offer, required this.termsVersion, super.key});

  final StudentAiOffer offer;
  final String termsVersion;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = studentAiStatusOf(offer);
    final optIn = offer.optIn;
    final period = offer.period;

    final Widget body;
    if (optIn != null) {
      body = _OptedInBody(optIn: optIn);
    } else if (offer.canOptIn && period != null) {
      body = _AvailableBody(
        // New terms are a new offer: the parent ticks the box again for them.
        key: ValueKey('${offer.studentId}/$termsVersion'),
        offer: offer,
        period: period,
        termsVersion: termsVersion,
      );
    } else {
      body = const _ClosedBody();
    }

    return AppSectionCard(
      key: ValueKey('studentAiOffer-${offer.studentId}'),
      title: 'studentAiOptIn.offer.title'.tr(namedArgs: {'child': offer.studentName}),
      icon: Icons.auto_awesome_outlined,
      accent: AppAccent.violet,
      trailing: AppStatusPill(label: status.labelKey.tr(), tone: status.tone),
      child: body,
    );
  }
}

class _AvailableBody extends ConsumerStatefulWidget {
  const _AvailableBody({
    required this.offer,
    required this.period,
    required this.termsVersion,
    super.key,
  });

  final StudentAiOffer offer;
  final StudentAiPeriod period;
  final String termsVersion;

  @override
  ConsumerState<_AvailableBody> createState() => _AvailableBodyState();
}

class _AvailableBodyState extends ConsumerState<_AvailableBody> {
  bool _accepted = false;
  bool _submitting = false;

  Future<void> _confirm() async {
    final child = widget.offer.studentName;
    final messenger = ScaffoldMessenger.of(context);
    void say(String message) => messenger.showSnackBar(SnackBar(content: Text(message)));

    setState(() => _submitting = true);
    try {
      await ref
          .read(studentAiClientProvider)
          .optIn(studentId: widget.offer.studentId, termsVersion: widget.termsVersion);
      say('studentAiOptIn.offer.confirmed'.tr(namedArgs: {'child': child}));
      ref.invalidate(studentAiOffersProvider);
    } on DioException catch (error) {
      final code = error.apiError?.code;
      final messageKey = switch (code) {
        'AI_OPTIN_WINDOW_CLOSED' => 'studentAiOptIn.offer.errors.windowClosed',
        'AI_OPTIN_ALREADY_OPTED_IN' => 'studentAiOptIn.offer.errors.alreadyOptedIn',
        'AI_OPTIN_NOT_ELIGIBLE' => 'studentAiOptIn.offer.errors.notEligible',
        'AI_OPTIN_TERMS_CHANGED' ||
        'AI_OPTIN_TERMS_REQUIRED' => 'studentAiOptIn.offer.errors.termsChanged',
        _ => 'studentAiOptIn.offer.errors.generic',
      };
      say(messageKey.tr(namedArgs: {'child': child}));
      if (code != null && code.startsWith('AI_OPTIN_')) {
        // The offer moved on (new terms, closed, or already confirmed): show it as it is
        // now, and make the parent tick the box again for whatever they confirm next.
        if (mounted) setState(() => _accepted = false);
        ref.invalidate(studentAiOffersProvider);
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final locale = context.locale.toString();
    final period = widget.period;
    final window = widget.offer.window;
    final child = widget.offer.studentName;
    final month = DateFormat.yMMMM(locale);

    Widget bullets(List<String> lines) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final line in lines)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('•  '),
                Expanded(child: Text(line, style: textTheme.bodyMedium)),
              ],
            ),
          ),
      ],
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'studentAiOptIn.offer.offeredBy'.tr(),
          key: const Key('studentAiOfferedBy'),
          style: textTheme.titleSmall,
        ),
        const SizedBox(height: AppSpacing.space4),
        Text(
          'studentAiOptIn.offer.period'.tr(
            namedArgs: {
              'start': month.format(period.startMonth),
              'end': month.format(period.endMonth),
            },
          ),
          style: textTheme.bodySmall,
        ),
        if (window != null)
          Text(
            'studentAiOptIn.offer.closesOn'.tr(
              namedArgs: {'date': DateFormat.yMMMd(locale).format(window.closesOn)},
            ),
            style: textTheme.bodySmall,
          ),
        const SizedBox(height: AppSpacing.space12),
        Text('studentAiOptIn.offer.includesTitle'.tr(), style: textTheme.titleSmall),
        const SizedBox(height: AppSpacing.space4),
        bullets([
          'studentAiOptIn.offer.includesHelper'.tr(namedArgs: {'child': child}),
          'studentAiOptIn.offer.includesClasses'.tr(namedArgs: {'child': child}),
          'studentAiOptIn.offer.includesYear'.tr(),
        ]),
        const SizedBox(height: AppSpacing.space8),
        Text('studentAiOptIn.offer.termsTitle'.tr(), style: textTheme.titleSmall),
        const SizedBox(height: AppSpacing.space4),
        bullets([
          'studentAiOptIn.offer.termsCommitted'.tr(),
          'studentAiOptIn.offer.termsFees'.tr(),
          'studentAiOptIn.offer.termsFromSchool'.tr(),
          'studentAiOptIn.offer.termsFinal'.tr(),
        ]),
        CheckboxListTile(
          key: const Key('studentAiAccept'),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          value: _accepted,
          onChanged: _submitting ? null : (value) => setState(() => _accepted = value ?? false),
          title: Text(
            'studentAiOptIn.offer.accept'.tr(namedArgs: {'child': child}),
            style: textTheme.bodyMedium,
          ),
        ),
        const SizedBox(height: AppSpacing.space8),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            key: const Key('studentAiConfirm'),
            onPressed: _accepted && !_submitting ? _confirm : null,
            child: _submitting
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text('studentAiOptIn.offer.confirm'.tr()),
          ),
        ),
      ],
    );
  }
}

class _OptedInBody extends StatelessWidget {
  const _OptedInBody({required this.optIn});

  final StudentAiOptIn optIn;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final locale = context.locale.toString();
    final month = DateFormat.yMMMM(locale);
    final child = optIn.studentName;
    final ended = !optIn.isActive;

    final lines = <String?>[
      if (optIn.source == StudentAiOptInSource.schoolOnBehalf)
        'studentAiOptIn.optedIn.recordedBySchool'.tr(),
      if (optIn.source == StudentAiOptInSource.transfer)
        'studentAiOptIn.optedIn.transferred'.tr(namedArgs: {'child': child}),
      if (ended)
        switch (optIn.status) {
          StudentAiOptInStatus.released when optIn.releasedEffectiveMonth != null =>
            'studentAiOptIn.ended.released'.tr(
              namedArgs: {'month': month.format(optIn.releasedEffectiveMonth!)},
            ),
          StudentAiOptInStatus.transferred => 'studentAiOptIn.ended.transferred'.tr(),
          _ => null,
        }
      else ...[
        optIn.waitingForSeat
            ? 'studentAiOptIn.optedIn.waitingSeat'.tr()
            : 'studentAiOptIn.optedIn.seatReady'.tr(namedArgs: {'child': child}),
        'studentAiOptIn.optedIn.committed'.tr(),
      ],
    ].nonNulls.toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          (ended ? 'studentAiOptIn.ended.headline' : 'studentAiOptIn.optedIn.headline').tr(
            namedArgs: {'child': child},
          ),
          style: textTheme.titleSmall,
        ),
        const SizedBox(height: AppSpacing.space4),
        Text(
          [
            'studentAiOptIn.offer.period'.tr(
              namedArgs: {
                'start': month.format(optIn.startMonth),
                'end': month.format(optIn.endMonth),
              },
            ),
            'studentAiOptIn.optedIn.inFees'.tr(),
          ].join(' · '),
          style: textTheme.bodyMedium,
        ),
        for (final line in lines) ...[
          const SizedBox(height: AppSpacing.space8),
          Text(line, style: textTheme.bodyMedium),
        ],
      ],
    );
  }
}

class _ClosedBody extends ConsumerWidget {
  const _ClosedBody();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final school =
        ref.watch(accountProfileProvider).value?.school.name ??
        'studentAiOptIn.closed.yourSchool'.tr();
    return Text(
      'studentAiOptIn.closed.body'.tr(namedArgs: {'school': school}),
      style: Theme.of(context).textTheme.bodyMedium,
    );
  }
}
