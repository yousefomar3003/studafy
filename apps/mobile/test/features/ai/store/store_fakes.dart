import 'dart:async';

import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_backend.dart';
import 'package:studafy_mobile/src/features/ai/store/store_gateway.dart';
import 'package:studafy_mobile/src/features/ai/store/withdrawal_waiver_store.dart';

/// A store and a server for the in-app purchase flow, answering with what each test sets.

const studentId = '6f1c9d52-3b7a-4c1e-9a55-0d2b8e4f7a10';
const schoolId = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

const siblingId = '9c0d4e21-7f3b-4a6e-8b11-2c5d6e7f8a90';

AiStoreSetup storeSetup({
  bool purchasable = true,
  bool google = true,
  bool apple = true,
  String productId = 'studafy_ai_monthly',
  bool subscribed = false,
  AiStoreUnavailableReason? unavailableReason,
  String forStudent = studentId,
}) => AiStoreSetup(
  enabled: true,
  productId: purchasable ? productId : null,
  apple: apple,
  google: google,
  purchasable: purchasable,
  accountToken: purchasable ? forStudent : null,
  profileId: purchasable ? schoolId : null,
  studentId: forStudent,
  studentFirstName: 'Sara',
  subscribed: subscribed,
  unavailableReason: unavailableReason,
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

  /// The student each setup was asked for (null: the signed-in student).
  final askedFor = <String?>[];

  /// The withdrawal waiver sent with each registration, in the same order as [registered].
  final waivers = <DateTime?>[];
  Object? refusal;

  /// Who the server credits a registered purchase to; defaults to the offer's student.
  String? creditTo;

  @override
  Future<AiStoreSetup> setup({String? studentId}) async {
    askedFor.add(studentId);
    return config;
  }

  @override
  Future<String> register(
    StorePlatform platform,
    String verificationData, {
    DateTime? withdrawalWaiverAcknowledgedAt,
  }) async {
    registered.add((platform, verificationData));
    waivers.add(withdrawalWaiverAcknowledgedAt);
    if (refusal != null) throw refusal!;
    return creditTo ?? config.studentId ?? studentId;
  }
}

/// The device's kept waiver, in memory.
class FakeWaiverStore implements WithdrawalWaiverStore {
  DateTime? kept;

  @override
  Future<DateTime?> read() async => kept;

  @override
  Future<void> save(DateTime acknowledgedAt) async => kept = acknowledgedAt;

  @override
  Future<void> clear() async => kept = null;
}
