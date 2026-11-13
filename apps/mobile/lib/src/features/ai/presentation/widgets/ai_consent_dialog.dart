import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/ai_consent_providers.dart';
import '../../domain/ai_consent.dart';
import 'ai_consent_disclosure.dart';

/// Opens the AI data-sharing consent modal (ST-305) for [disclosure]. Resolves true once consent is
/// recorded server-side, false if the user declines or dismisses it. Not dismissible by tapping
/// outside: the choice is explicit either way.
Future<bool> showAiConsentDialog(BuildContext context, AiDataSharingDisclosure disclosure) async {
  final granted = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (_) => AiConsentDialog(disclosure: disclosure),
  );
  return granted ?? false;
}

class AiConsentDialog extends ConsumerStatefulWidget {
  const AiConsentDialog({required this.disclosure, super.key});

  final AiDataSharingDisclosure disclosure;

  @override
  ConsumerState<AiConsentDialog> createState() => _AiConsentDialogState();
}

class _AiConsentDialogState extends ConsumerState<AiConsentDialog> {
  bool _saving = false;
  bool _failed = false;

  Future<void> _allow() async {
    setState(() {
      _saving = true;
      _failed = false;
    });
    try {
      await ref.read(aiConsentProvider.notifier).grant(widget.disclosure.version);
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      // The disclosure changed while this was open: close without consent, so the user is shown
      // the new one rather than agreeing to something they haven't read.
      if (isAiConsentDisclosureOutdated(error)) {
        if (mounted) Navigator.of(context).pop(false);
        return;
      }
      if (mounted) {
        setState(() {
          _saving = false;
          _failed = true;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return AlertDialog(
      scrollable: true,
      title: Text('ai.consent.title'.tr(namedArgs: {'provider': widget.disclosure.providerName})),
      content: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          AiConsentDisclosure(disclosure: widget.disclosure),
          if (_failed) ...[
            const SizedBox(height: AppSpacing.space8),
            Text('ai.consent.saveError'.tr(), style: TextStyle(color: colorScheme.error)),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.of(context).pop(false),
          child: Text('ai.consent.decline'.tr()),
        ),
        FilledButton(onPressed: _saving ? null : _allow, child: Text('ai.consent.allow'.tr())),
      ],
    );
  }
}
