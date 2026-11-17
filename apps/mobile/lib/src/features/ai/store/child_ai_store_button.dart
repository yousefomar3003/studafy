import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import 'ai_store_controller.dart';
import 'ai_store_offer_card.dart';
import 'store_gateway.dart';

/// "Studafy AI for (name)" on a child's page in the parent app: opens the in-app purchase offer
/// for that child, bought on the parent's phone and credited to the child. Nothing on a device
/// without a store.
///
/// One App Store / Google Play account holds one subscription per product, so the server offers a
/// second child the next product; the sheet says plainly when it cannot be bought for this child.
///
/// A child holding a school seat is never sold it: the button is not shown once the server says
/// the school provides it (and the sheet, if opened before that is known, says "Provided by …").
class ChildAiStoreButton extends ConsumerWidget {
  const ChildAiStoreButton({required this.studentId, required this.childName, super.key});

  final String studentId;
  final String childName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (currentStorePlatform() == null) return const SizedBox.shrink();
    if (ref.watch(aiStoreCoveredBySchoolProvider(studentId)).value ?? false) {
      return const SizedBox.shrink();
    }
    return TextButton.icon(
      key: const ValueKey('childAiStore'),
      icon: const Icon(Icons.auto_awesome_outlined, size: 18),
      label: Text('aiStore.childButton'.tr(namedArgs: {'name': _firstName(childName)})),
      onPressed: () => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (context) => SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space16,
              0,
              AppSpacing.space16,
              AppSpacing.space24,
            ),
            child: AiStoreOfferCard(studentId: studentId),
          ),
        ),
      ),
    );
  }

  static String _firstName(String name) => name.trim().split(RegExp(r'\s+')).first;
}
