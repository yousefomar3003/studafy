import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studafy_mobile/src/core/auth/secure_token_store.dart';

/// In-memory [FlutterSecureStorage]: the real one's platform channel has no handler under
/// `flutter test`.
class _MemoryStorage implements FlutterSecureStorage {
  final values = <String, String>{};

  @override
  Future<void> write({
    required String key,
    required String? value,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      values.remove(key);
    } else {
      values[key] = value;
    }
  }

  @override
  Future<String?> read({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      values[key];

  @override
  Future<void> delete({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      values.remove(key);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late _MemoryStorage storage;
  late SecureTokenStore store;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    storage = _MemoryStorage();
    store = SecureTokenStore(storage: storage);
    await store.save(accessToken: 'a', refreshToken: 'r', sessionId: 's');
  });

  test('first launch of an install drops tokens a previous install left behind', () async {
    await store.discardIfReinstalled();

    expect(await store.readAccessToken(), isNull);
    expect(await store.readRefreshToken(), isNull);
    expect(await store.readSessionId(), isNull);
  });

  test('later launches of the same install keep the session', () async {
    await store.discardIfReinstalled();
    await store.save(accessToken: 'a2', refreshToken: 'r2', sessionId: 's2');

    await store.discardIfReinstalled();

    expect(await store.readAccessToken(), 'a2');
    expect(await store.readRefreshToken(), 'r2');
    expect(await store.readSessionId(), 's2');
  });

  test('a member device token outlives sign-out but not a reinstall', () async {
    await store.discardIfReinstalled();
    await store.writeMemberDeviceToken('stu-100001 ', 'device-1');
    await store.writeMemberDeviceToken('PAR-200002', 'device-2');

    // Matched however the member typed their ID.
    expect(await store.readMemberDeviceToken('STU-100001'), 'device-1');
    expect(await store.readMemberDeviceToken('par-200002'), 'device-2');
    expect(await store.readMemberDeviceToken('STU-999999'), isNull);

    // Signing out keeps it: that is what lets this phone in while the account is locked.
    await store.clear();
    expect(await store.readMemberDeviceToken('STU-100001'), 'device-1');

    // A new install (or a phone that changed hands) starts untrusted.
    SharedPreferences.setMockInitialValues({});
    await store.discardIfReinstalled();
    expect(await store.readMemberDeviceToken('STU-100001'), isNull);
  });
}
