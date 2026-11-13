import 'package:flutter/foundation.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';

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

  /// The store's own product, with its localized price; null when the store does not offer it.
  Future<ProductDetails?> product(String productId);

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
  Future<ProductDetails?> product(String productId) async {
    final response = await _store.queryProductDetails({productId});
    // Play lists one entry per offer of a subscription; the AI add-on has a single base plan.
    return response.productDetails.where((p) => p.id == productId).firstOrNull;
  }

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
