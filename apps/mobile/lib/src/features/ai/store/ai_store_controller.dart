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

/// What the app shows about buying the add-on in the app for one student.
sealed class AiStoreState {
  const AiStoreState();
}

/// Nothing: no store on this device, or the signed-in user is not someone who could buy it.
class AiStoreHidden extends AiStoreState {
  const AiStoreHidden();
}

/// It cannot be bought for this student right now, and [messageKey] says why — instead of the
/// offer silently not appearing. [name] is the student's first name, for messages that use it.
class AiStoreUnavailable extends AiStoreState {
  const AiStoreUnavailable(this.messageKey, {this.name});

  final String messageKey;
  final String? name;
}

/// The student's AI add-on is already on (shown to a parent looking at their child).
class AiStoreSubscribed extends AiStoreState {
  const AiStoreSubscribed({this.name});

  final String? name;
}

enum AiStoreBusy { none, purchasing, restoring }

/// The add-on is for sale. [price] is the store's own localized price string — never a price
/// this app knows itself.
class AiStoreOffering extends AiStoreState {
  const AiStoreOffering({
    required this.price,
    this.busy = AiStoreBusy.none,
    this.messageKey,
    this.messageIsError = true,
    this.waiverAcknowledged = false,
    this.name,
  });

  final String price;
  final AiStoreBusy busy;

  /// The buyer ticked "start now, and I lose my 14-day right to cancel once it starts" (EU
  /// consumer law; Terms of Service 7.7). The store's purchase sheet opens only once they have.
  final bool waiverAcknowledged;

  /// A translation key for the outcome of the last attempt, if it needs saying. It may use
  /// `{name}`, filled with [name].
  final String? messageKey;

  /// Whether [messageKey] reports a failure (shown in the error colour) or just an outcome.
  final bool messageIsError;

  /// The first name of the student it is for.
  final String? name;
}

/// The server accepted a purchase; the AI tab is reloading into the subscribed state.
class AiStoreActivated extends AiStoreState {
  const AiStoreActivated({this.name});

  final String? name;
}

/// The in-app purchase of the AI add-on (`docs/runbooks/in-app-purchase-setup.md`), for the
/// signed-in student (`null`) or, in the parent app, for one of the parent's children (their
/// student id):
///
/// 1. Offer it only where the server says it may be bought for this student on this device's
///    store, and say why when it cannot.
/// 2. Buy only once the buyer has asked for it to start now and acknowledged losing the 14-day
///    right to cancel, and send that acknowledgement with the purchase it was given for — kept on
///    the device ([WithdrawalWaiverStore]) until then, since the purchase may arrive on a later
///    launch. Never with a restored purchase.
/// 3. Buy the product the server picked for this student, with the student's id stamped on the
///    purchase (the server credits it to that student only). One store account holds one
///    subscription per product, so a second child on the same phone gets the next product.
/// 4. Send each delivered purchase to the server, and finish it with the store only once the
///    server has recorded it — an unfinished purchase is redelivered on the next launch, so a
///    failed report retries itself. A purchase the server refuses for good (another family's,
///    lapsed) is finished too, or it would be redelivered forever. A brother or sister's purchase
///    the store redelivers here is credited to them by the server.
final aiStoreProvider = AsyncNotifierProvider.autoDispose
    .family<AiStoreController, AiStoreState, String?>(AiStoreController.new);

class AiStoreController extends AsyncNotifier<AiStoreState> {
  AiStoreController(this.forStudentId);

  /// The parent's child to buy for; null for the signed-in student.
  final String? forStudentId;

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
  bool _restoring = false;
  String? _restoreOutcome;

  String? get _name => _setup?.studentFirstName;

  @override
  Future<AiStoreState> build() async {
    final platform = currentStorePlatform();
    if (platform == null) return const AiStoreHidden();

    _gateway = ref.watch(storeGatewayProvider);
    _backend = ref.watch(aiStoreBackendProvider);
    _waivers = ref.watch(withdrawalWaiverStoreProvider);
    final AiStoreSetup setup;
    try {
      setup = await _backend.setup(studentId: forStudentId);
    } on Object {
      return const AiStoreUnavailable('aiStore.unavailable.loadFailed');
    }
    _setup = setup;
    final name = setup.studentFirstName;

    if (setup.subscribed) return AiStoreSubscribed(name: name);
    switch (setup.unavailableReason) {
      case AiStoreUnavailableReason.notStudent:
        return const AiStoreHidden();
      case AiStoreUnavailableReason.notConfigured:
        return AiStoreUnavailable('aiStore.unavailable.notConfigured', name: name);
      case AiStoreUnavailableReason.schoolPlanInactive:
        return AiStoreUnavailable('aiStore.unavailable.schoolPlan', name: name);
      case AiStoreUnavailableReason.noFreeProduct:
        return AiStoreUnavailable('aiStore.unavailable.familyFull', name: name);
      case null:
        break;
    }
    if (!setup.offers(platform)) {
      return AiStoreUnavailable('aiStore.unavailable.notConfigured', name: name);
    }

    try {
      if (!await _gateway.isAvailable()) {
        return AiStoreUnavailable('aiStore.unavailable.store', name: name);
      }
      final product = await _gateway.product(setup.productId!);
      // The store does not list the product picked for this student — for a second child, the
      // extra product has not been set up in the store yet.
      if (product == null) return AiStoreUnavailable('aiStore.unavailable.notListed', name: name);
      _platform = platform;
      _product = product;
    } on Object {
      return AiStoreUnavailable('aiStore.unavailable.store', name: name);
    }

    final subscription = _gateway.purchaseStream.listen(_onPurchases);
    ref.onDispose(subscription.cancel);
    return AiStoreOffering(price: _product!.price, name: name);
  }

  /// Ticks or unticks the withdrawal acknowledgement on the offer.
  void acknowledgeWaiver(bool acknowledged) {
    final offer = state.value;
    if (offer is! AiStoreOffering || offer.busy != AiStoreBusy.none) return;
    state = AsyncData(
      AiStoreOffering(
        price: offer.price,
        messageKey: offer.messageKey,
        messageIsError: offer.messageIsError,
        waiverAcknowledged: acknowledged,
        name: offer.name,
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

  /// Asks the store to redeliver this store account's purchases, then says what came of it: on
  /// for this student, on for a brother or sister instead, or nothing to restore.
  Future<void> restore() async {
    final offer = state.value;
    if (_setup == null || offer is! AiStoreOffering || offer.busy != AiStoreBusy.none) return;
    _restoring = true;
    _restoreOutcome = null;
    _offer(busy: AiStoreBusy.restoring);
    try {
      await _gateway.restore(accountToken: _setup!.accountToken);
    } on Object {
      _restoring = false;
      _offer(messageKey: 'aiStore.errors.storeFailed');
      return;
    }
    await Future<void>.delayed(restoreSettle);
    if (!ref.mounted) return;
    _restoring = false;
    if (state.value is! AiStoreOffering) return;
    switch (_restoreOutcome) {
      case final key?:
        _offer(messageKey: key, messageIsError: false);
      case null:
        _offer(messageKey: 'aiStore.restore.none', messageIsError: false);
    }
  }

  Future<void> _onPurchases(List<PurchaseDetails> purchases) async {
    for (final purchase in purchases) {
      // Any of the add-on's products: a brother or sister's may be redelivered here too.
      if (!_isAddOnProduct(purchase.productID)) continue;
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
          await _register(
            purchase,
            waiver: purchase.productID == _setup?.productId
                ? _waiverAcknowledgedAt ?? await _waivers.read()
                : null,
          );
        case PurchaseStatus.restored:
          await _register(purchase);
      }
      if (!ref.mounted) return;
    }
  }

  /// Whether [productId] is one of the add-on's products: the one offered here, or a brother or
  /// sister's. They share the primary id as a prefix (`studafy_ai_monthly`,
  /// `studafy_ai_monthly_2`, ...); the server checks the real list.
  bool _isAddOnProduct(String productId) {
    final offered = _setup?.productId;
    if (offered == null) return false;
    if (productId == offered) return true;
    final base = offered.replaceFirst(RegExp(r'_\d+$'), '');
    return productId == base || RegExp('^${RegExp.escape(base)}_\\d+\$').hasMatch(productId);
  }

  Future<void> _register(PurchaseDetails purchase, {DateTime? waiver}) async {
    _offer(busy: _restoring ? AiStoreBusy.restoring : AiStoreBusy.purchasing);
    final String creditedTo;
    try {
      creditedTo = await _backend.register(
        _platform!,
        purchase.verificationData.serverVerificationData,
        withdrawalWaiverAcknowledgedAt: waiver,
      );
    } on DioException catch (error) {
      final refusal = _finalRefusals[error.apiError?.code];
      if (refusal != null) {
        await _finish(purchase);
        if (waiver != null) await _forgetWaiver();
        _restoreOutcome = refusal;
        _offer(
          busy: _restoring ? AiStoreBusy.restoring : AiStoreBusy.none,
          messageKey: _restoring ? null : refusal,
        );
      } else {
        // Left unfinished: the store redelivers it on the next launch and it is reported again.
        _offer(messageKey: 'aiStore.errors.verifyLater');
      }
      return;
    }
    await _finish(purchase);
    if (waiver != null) await _forgetWaiver();
    if (!ref.mounted) return;
    ref.invalidate(myFeaturesProvider);
    final target = _setup?.studentId;
    if (target != null && creditedTo.toLowerCase() != target.toLowerCase()) {
      // A brother or sister's purchase, redelivered by this phone's store account: it is on for
      // them now, and this student's offer stays.
      _restoreOutcome = 'aiStore.restore.forSibling';
      _offer(
        busy: _restoring ? AiStoreBusy.restoring : AiStoreBusy.none,
        messageKey: _restoring ? null : 'aiStore.restore.forSibling',
        messageIsError: false,
      );
      return;
    }
    _restoreOutcome = 'aiStore.restore.done';
    state = AsyncData(AiStoreActivated(name: _name));
    ref.invalidate(aiHubStatusProvider);
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

  void _offer({
    AiStoreBusy busy = AiStoreBusy.none,
    String? messageKey,
    bool messageIsError = true,
  }) {
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
        messageIsError: messageIsError,
        waiverAcknowledged: acknowledged,
        name: _name,
      ),
    );
  }
}
