import '../../../core/api/generated/models/ai_store_purchase_request.dart';
import '../../../core/api/generated/models/ai_store_purchase_request_platform.dart';
import '../../../core/api/generated/subscriptions/subscriptions_client.dart';

/// Which store a purchase goes through.
enum StorePlatform { apple, google }

/// What the server says about selling the AI add-on in the app to the signed-in user
/// (`GET /api/subscriptions/ai/store/config`).
class AiStoreSetup {
  const AiStoreSetup({
    required this.enabled,
    required this.productId,
    required this.apple,
    required this.google,
    required this.purchasable,
    required this.accountToken,
    required this.profileId,
  });

  final bool enabled;
  final String? productId;
  final bool apple;
  final bool google;

  /// A student whose school's own plan is live — the add-on only works on top of that.
  final bool purchasable;

  /// The student's id, stamped on the purchase (Apple `appAccountToken`, Google
  /// `obfuscatedAccountId`). The server refuses a purchase that does not carry it.
  final String? accountToken;

  /// The school's id (Google `obfuscatedProfileId`).
  final String? profileId;

  /// Whether the add-on is offered on [platform] to this user.
  bool offers(StorePlatform platform) =>
      enabled &&
      purchasable &&
      productId != null &&
      accountToken != null &&
      (platform == StorePlatform.apple ? apple : google);
}

/// The server side of an in-app purchase: the setup to offer, and registering a completed
/// purchase so the server verifies it with the store and turns the add-on on.
abstract interface class AiStoreBackend {
  Future<AiStoreSetup> setup();

  /// Throws a `DioException` carrying an `ApiException` when the server refuses the purchase.
  Future<void> register(StorePlatform platform, String verificationData);
}

/// [AiStoreBackend] over the generated client's two in-app purchase methods — the only calls
/// this app makes to the subscription API (pinned by `test/store_compliance`).
class ApiAiStoreBackend implements AiStoreBackend {
  ApiAiStoreBackend(this._client);

  final SubscriptionsClient _client;

  @override
  Future<AiStoreSetup> setup() async {
    final config = await _client.getAiStoreConfig();
    return AiStoreSetup(
      enabled: config.enabled,
      productId: config.productId,
      apple: config.platforms.apple,
      google: config.platforms.google,
      purchasable: config.purchasable,
      accountToken: config.accountToken,
      profileId: config.profileId,
    );
  }

  @override
  Future<void> register(StorePlatform platform, String verificationData) async {
    await _client.registerAiStorePurchase(
      body: AiStorePurchaseRequest(
        platform: platform == StorePlatform.apple
            ? AiStorePurchaseRequestPlatform.apple
            : AiStorePurchaseRequestPlatform.google,
        verificationData: verificationData,
      ),
    );
  }
}
