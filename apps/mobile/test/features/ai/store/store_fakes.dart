import 'dart:async';

import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_backend.dart';
import 'package:studafy_mobile/src/features/ai/store/store_gateway.dart';

/// A store and a server for the in-app purchase flow, answering with what each test sets.

const studentId = '6f1c9d52-3b7a-4c1e-9a55-0d2b8e4f7a10';
const schoolId = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

AiStoreSetup storeSetup({bool purchasable = true, bool google = true, bool apple = true}) =>
    AiStoreSetup(
      enabled: true,
      productId: 'studafy_ai_monthly',
      apple: apple,
      google: google,
      purchasable: purchasable,
      accountToken: purchasable ? studentId : null,
      profileId: purchasable ? schoolId : null,
    );

class FakeGateway implements StoreGateway {
  final purchases = StreamController<List<PurchaseDetails>>.broadcast();
  bool available = true;
  ProductDetails? listed = ProductDetails(
    id: 'studafy_ai_monthly',
    title: 'Studafy AI',
    description: 'AI study assistant',
    price: 'JOD 2.990',
    rawPrice: 2.99,
    currencyCode: 'JOD',
  );
  final bought = <({String accountToken, String? profileId})>[];
  final completed = <PurchaseDetails>[];
  int restores = 0;

  @override
  Stream<List<PurchaseDetails>> get purchaseStream => purchases.stream;

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<ProductDetails?> product(String productId) async => listed;

  @override
  Future<void> buy(
    ProductDetails product, {
    required String accountToken,
    String? profileId,
  }) async {
    bought.add((accountToken: accountToken, profileId: profileId));
  }

  @override
  Future<void> restore({String? accountToken}) async => restores++;

  @override
  Future<void> complete(PurchaseDetails purchase) async => completed.add(purchase);
}

class FakeBackend implements AiStoreBackend {
  FakeBackend(this.config);

  AiStoreSetup config;
  final registered = <(StorePlatform, String)>[];
  Object? refusal;

  @override
  Future<AiStoreSetup> setup() async => config;

  @override
  Future<void> register(StorePlatform platform, String verificationData) async {
    registered.add((platform, verificationData));
    if (refusal != null) throw refusal!;
  }
}
