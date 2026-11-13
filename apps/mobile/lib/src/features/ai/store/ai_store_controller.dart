import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:in_app_purchase/in_app_purchase.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/auth_providers.dart';
import '../application/ai_hub_providers.dart';
import 'ai_store_backend.dart';
import 'store_gateway.dart';
import 'withdrawal_waiver_store.dart';
import '../../../core/features/features_providers.dart';

final storeGatewayProvider = Provider<StoreGateway>((ref) => InAppPurchaseGateway());

final aiStoreBackendProvider = Provider<AiStoreBackend>(
  (ref) => ApiAiStoreBackend(ref.watch(apiClientProvider).subscriptions),
);

final withdrawalWaiverStoreProvider = Provider<WithdrawalWaiverStore>(
  (ref) => SharedPreferencesWithdrawalWaiverStore(),
);

/// The in-app copy of the signed-in student's purchase confirmation (the withdrawal waiver they gave
/// before buying), or null: none recorded, no store on this device, or it could not be loaded. For a
/// member-ID account with no email address this is the only confirmation they get.
final aiStorePurchaseConfirmationProvider =
    FutureProvider.autoDispose<AiStorePurchaseConfirmation?>((ref) async {
      if (currentStorePlatform() == null) return null;
      try {
        return (await ref.watch(aiStoreBackendProvider).setup()).purchaseConfirmation;
      } on Object {
        return null;
      }
    });

/// What the AI tab shows about buying the add-on in the app.
sealed class AiStoreState {
  const AiStoreState();
}

/// Nothing: no store on this device, the server does not sell it here, this user cannot buy it,
/// or the store does not list the product.
class AiStoreHidden extends AiStoreState {
  const AiStoreHidden();
}

enum AiStoreBusy { none, purchasing, restoring }

/// The add-on is for sale. [price] is the store's own localized price string — never a price
/// this app knows itself.
class AiStoreOffering extends AiStoreState {
  const AiStoreOffering({
    required this.price,
    this.busy = AiStoreBusy.none,
    this.messageKey,
    this.waiverAcknowledged = false,
  });

  final String price;
  final AiStoreBusy busy;

  /// The student ticked "start now, and I lose my 14-day right to cancel once it starts" (EU
  /// consumer law; Terms of Service 7.7). The store's purchase sheet opens only once they have.
  final bool waiverAcknowledged;

  /// A translation key for the outcome of the last attempt, if it needs saying.
  final String? messageKey;
}

/// The server accepted a purchase; the AI tab is reloading into the subscribed state.
class AiStoreActivated extends AiStoreState {
  const AiStoreActivated();
}

/// The in-app purchase of the AI add-on (`docs/runbooks/in-app-purchase-setup.md`):
///
/// 1. Offer it only where the server says this user may buy it on this device's store.
/// 2. Buy only once the student has asked for it to start now and acknowledged losing the 14-day
///    right to cancel, and send that acknowledgement with the purchase it was given for — kept on
///    the device ([WithdrawalWaiverStore]) until then, since the purchase may arrive on a later
///    launch. Never with a restored purchase.
/// 3. Buy with the student's id stamped on the purchase (the server refuses one without it).
/// 4. Send each delivered purchase to the server, and finish it with the store only once the
///    server has recorded it — an unfinished purchase is redelivered on the next launch, so a
///    failed report retries itself. A purchase the server refuses for good (another account's,
///    lapsed) is finished too, or it would be redelivered forever.
final aiStoreProvider = AsyncNotifierProvider.autoDispose<AiStoreController, AiStoreState>(
  AiStoreController.new,
);

class AiStoreController extends AsyncNotifier<AiStoreState> {
  /// How long a restore waits for the store to redeliver something before saying there was none.
  static const restoreSettle = Duration(seconds: 3);

  /// Refusals no retry changes: the purchase is finished with the store and the reason shown.
  static const _finalRefusals = {
    'STORE_PURCHASE_ACCOUNT_MISMATCH': 'aiStore.errors.otherAccount',
    'STORE_PURCHASE_ALREADY_CLAIMED': 'aiStore.errors.otherAccount',
    'STORE_PURCHASE_NOT_ACTIVE': 'aiStore.errors.notActive',
    'STORE_PURCHASE_INVALID': 'aiStore.errors.invalid',
  };

  late StoreGateway _gateway;
  late AiStoreBackend _backend;
  late WithdrawalWaiverStore _waivers;

  /// The waiver given for the purchase in progress, also kept in [_waivers] across launches.
  DateTime? _waiverAcknowledgedAt;
  ProductDetails? _product;
  AiStoreSetup? _setup;
  StorePlatform? _platform;
  bool _delivered = false;

  @override
  Future<AiStoreState> build() async {
    final platform = currentStorePlatform();
    if (platform == null) return const AiStoreHidden();

    try {
      _gateway = ref.watch(storeGatewayProvider);
      _backend = ref.watch(aiStoreBackendProvider);
      _waivers = ref.watch(withdrawalWaiverStoreProvider);
      final setup = await _backend.setup();
      if (!setup.offers(platform) || !await _gateway.isAvailable()) {
        return const AiStoreHidden();
      }
      final product = await _gateway.product(setup.productId!);
      if (product == null) return const AiStoreHidden();
      _setup = setup;
      _platform = platform;
      _product = product;
    } on Object {
      // The offer is an extra on top of the not-active notice: if it cannot load, the notice
      // alone is shown, and pull-to-refresh tries again.
      return const AiStoreHidden();
    }

    final subscription = _gateway.purchaseStream.listen(_onPurchases);
    ref.onDispose(subscription.cancel);
    return AiStoreOffering(price: _product!.price);
  }

  /// Ticks or unticks the withdrawal acknowledgement on the offer.
  void acknowledgeWaiver(bool acknowledged) {
    final offer = state.value;
    if (offer is! AiStoreOffering || offer.busy != AiStoreBusy.none) return;
    state = AsyncData(
      AiStoreOffering(
        price: offer.price,
        messageKey: offer.messageKey,
        waiverAcknowledged: acknowledged,
      ),
    );
  }

  Future<void> buy() async {
    final setup = _setup;
    final product = _product;
    final offer = state.value;
    if (setup == null || product == null) return;
    // The button is disabled until then; this is the same rule, not a second one.
    if (offer is! AiStoreOffering || !offer.waiverAcknowledged) return;
    final acknowledgedAt = DateTime.now().toUtc();
    _waiverAcknowledgedAt = acknowledgedAt;
    await _waivers.save(acknowledgedAt);
    _offer(busy: AiStoreBusy.purchasing);
    try {
      await _gateway.buy(product, accountToken: setup.accountToken!, profileId: setup.profileId);
    } on Object {
      await _forgetWaiver();
      _offer(messageKey: 'aiStore.errors.storeFailed');
    }
  }

  Future<void> restore() async {
    if (_setup == null) return;
    _delivered = false;
    _offer(busy: AiStoreBusy.restoring);
    try {
      await _gateway.restore(accountToken: _setup!.accountToken);
    } on Object {
      _offer(messageKey: 'aiStore.errors.storeFailed');
      return;
    }
    await Future<void>.delayed(restoreSettle);
    if (!ref.mounted) return;
    if (!_delivered && state.value is AiStoreOffering) {
      _offer(messageKey: 'aiStore.restore.none');
    }
  }

  Future<void> _onPurchases(List<PurchaseDetails> purchases) async {
    for (final purchase in purchases) {
      if (purchase.productID != _setup?.productId) continue;
      switch (purchase.status) {
        case PurchaseStatus.pending:
          _offer(busy: AiStoreBusy.purchasing);
        case PurchaseStatus.canceled:
          await _finish(purchase);
          await _forgetWaiver();
          _offer();
        case PurchaseStatus.error:
          await _finish(purchase);
          await _forgetWaiver();
          _offer(messageKey: 'aiStore.errors.storeFailed');
        case PurchaseStatus.purchased:
          _delivered = true;
          await _register(purchase, waiver: _waiverAcknowledgedAt ?? await _waivers.read());
        case PurchaseStatus.restored:
          _delivered = true;
          await _register(purchase);
      }
      if (!ref.mounted) return;
    }
  }

  Future<void> _register(PurchaseDetails purchase, {DateTime? waiver}) async {
    _offer(busy: AiStoreBusy.purchasing);
    try {
      await _backend.register(
        _platform!,
        purchase.verificationData.serverVerificationData,
        withdrawalWaiverAcknowledgedAt: waiver,
      );
    } on DioException catch (error) {
      final refusal = _finalRefusals[error.apiError?.code];
      if (refusal != null) {
        await _finish(purchase);
        if (waiver != null) await _forgetWaiver();
        _offer(messageKey: refusal);
      } else {
        // Left unfinished: the store redelivers it on the next launch and it is reported again.
        _offer(messageKey: 'aiStore.errors.verifyLater');
      }
      return;
    }
    await _finish(purchase);
    if (waiver != null) await _forgetWaiver();
    if (!ref.mounted) return;
    state = const AsyncData(AiStoreActivated());
    ref
      ..invalidate(aiHubStatusProvider)
      ..invalidate(myFeaturesProvider);
  }

  Future<void> _finish(PurchaseDetails purchase) async {
    if (!purchase.pendingCompletePurchase) return;
    try {
      await _gateway.complete(purchase);
    } on Object {
      // Redelivered next launch and finished then; the server side is idempotent.
    }
  }

  Future<void> _forgetWaiver() async {
    _waiverAcknowledgedAt = null;
    await _waivers.clear();
  }

  void _offer({AiStoreBusy busy = AiStoreBusy.none, String? messageKey}) {
    final product = _product;
    if (product == null || !ref.mounted) return;
    final acknowledged = switch (state.value) {
      AiStoreOffering(:final waiverAcknowledged) => waiverAcknowledged,
      _ => false,
    };
    state = AsyncData(
      AiStoreOffering(
        price: product.price,
        busy: busy,
        messageKey: messageKey,
        waiverAcknowledged: acknowledged,
      ),
    );
  }
}
