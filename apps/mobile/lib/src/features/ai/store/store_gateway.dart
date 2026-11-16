import 'package:flutter/foundation.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';
import 'package:in_app_purchase_storekit/store_kit_2_wrappers.dart';

import 'ai_store_backend.dart';

/// The store this device buys through, or null where neither store exists (desktop, web, tests).
StorePlatform? currentStorePlatform() => switch (defaultTargetPlatform) {
  TargetPlatform.iOS => StorePlatform.apple,
  TargetPlatform.android => StorePlatform.google,
  _ => null,
};

/// The App Store / Google Play billing the AI add-on is bought through — a seam over the
/// `in_app_purchase` plugin so the purchase flow can be tested without a store.
abstract interface class StoreGateway {
  /// Every purchase update: new purchases, restored ones, and ones left unfinished by an earlier
  /// run of the app (the store redelivers those until they are completed).
  Stream<List<PurchaseDetails>> get purchaseStream;

  Future<bool> isAvailable();

  /// The store's own products among [productIds], with their localized prices, by id. A product
  /// the store does not offer (not set up in App Store Connect / the Play Console) is absent.
  Future<Map<String, ProductDetails>> products(Set<String> productIds);

  /// The subscriptions this device's store account (its Apple ID / Google account) holds right
  /// now, whoever in the family they were bought for. One store account can hold only one
  /// subscription to a product, so these are the products it cannot buy again.
  Future<List<HeldSubscription>> heldSubscriptions();

  /// Starts the store's purchase sheet. The outcome arrives on [purchaseStream].
  Future<void> buy(ProductDetails product, {required String accountToken, String? profileId});

  /// Asks the store to redeliver this account's purchases on [purchaseStream].
  Future<void> restore({String? accountToken});

  /// Finishes a delivered purchase, so the store stops redelivering it.
  Future<void> complete(PurchaseDetails purchase);
}

class InAppPurchaseGateway implements StoreGateway {
  InAppPurchaseGateway([InAppPurchase? store]) : _store = store ?? InAppPurchase.instance;

  final InAppPurchase _store;

  @override
  Stream<List<PurchaseDetails>> get purchaseStream => _store.purchaseStream;

  @override
  Future<bool> isAvailable() => _store.isAvailable();

  @override
  Future<Map<String, ProductDetails>> products(Set<String> productIds) async {
    final response = await _store.queryProductDetails(productIds);
    // Play lists one entry per offer of a subscription; the AI add-on has a single base plan, so
    // the first entry of each id is the one.
    final byId = <String, ProductDetails>{};
    for (final product in response.productDetails) {
      if (productIds.contains(product.id)) byId.putIfAbsent(product.id, () => product);
    }
    return byId;
  }

  @override
  Future<List<HeldSubscription>> heldSubscriptions() async {
    if (currentStorePlatform() == StorePlatform.google) {
      // Play's queryPurchases(SUBS): the subscriptions the Google account owns now.
      final response = await _store
          .getPlatformAddition<InAppPurchaseAndroidPlatformAddition>()
          .queryPastPurchases();
      if (response.error != null) throw StateError(response.error!.message);
      return [
        for (final purchase in response.pastPurchases)
          if (purchase.billingClientPurchase.purchaseState == PurchaseStateWrapper.purchased)
            for (final productId in purchase.billingClientPurchase.products)
              HeldSubscription(
                productId: productId,
                accountToken: purchase.billingClientPurchase.obfuscatedAccountId,
              ),
      ];
    }
    // StoreKit 2's Transaction.all: every transaction of this Apple ID, renewals included. A
    // product is held while its latest transaction has not expired.
    final latest = <String, SK2Transaction>{};
    for (final transaction in await SK2Transaction.transactions()) {
      final kept = latest[transaction.productId];
      if (kept == null || _expiry(transaction) > _expiry(kept)) {
        latest[transaction.productId] = transaction;
      }
    }
    final now = DateTime.now().millisecondsSinceEpoch;
    return [
      for (final transaction in latest.values)
        if (_expiry(transaction) > now)
          HeldSubscription(
            productId: transaction.productId,
            accountToken: transaction.appAccountToken,
          ),
    ];
  }

  /// Milliseconds since epoch; 0 for a transaction with no expiry (not a subscription).
  static int _expiry(SK2Transaction transaction) =>
      int.tryParse(transaction.expirationDate ?? '') ??
      double.tryParse(transaction.expirationDate ?? '')?.toInt() ??
      0;

  @override
  Future<void> buy(ProductDetails product, {required String accountToken, String? profileId}) {
    // StoreKit 2 takes the student's id as the transaction's appAccountToken; Play as its
    // obfuscated account id, with the school's id as the obfuscated profile id.
    final param = currentStorePlatform() == StorePlatform.google
        ? GooglePlayPurchaseParam(
            productDetails: product,
            applicationUserName: accountToken,
            obfuscatedProfileId: profileId,
          )
        : PurchaseParam(productDetails: product, applicationUserName: accountToken);
    // Subscriptions go through buyNonConsumable on both stores.
    return _store.buyNonConsumable(purchaseParam: param);
  }

  @override
  Future<void> restore({String? accountToken}) =>
      _store.restorePurchases(applicationUserName: accountToken);

  @override
  Future<void> complete(PurchaseDetails purchase) => _store.completePurchase(purchase);
}

/// A subscription this device's store account holds.
class HeldSubscription {
  const HeldSubscription({required this.productId, this.accountToken});

  final String productId;

  /// The student id stamped on it when it was bought (Apple `appAccountToken`, Google
  /// `obfuscatedAccountId`), when the store reports one.
  final String? accountToken;
}
