import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../store/ai_store_offer_card.dart';
import 'ai_not_active_card.dart';

/// The existing AI paywall as a page: what the add-on includes, then the App Store / Google Play
/// offer. Shown by a gated AI screen (`FeatureGate`) only for a person the gate says may buy it --
/// never to someone the school covers or would cover with a seat.
class AiPaywall extends StatelessWidget {
  const AiPaywall({super.key});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      children: const [AiNotActiveCard(), AiStoreOfferCard()],
    );
  }
}
