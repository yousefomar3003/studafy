import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studafy_mobile/src/core/auth/app_lock.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';

/// The app lock (Face ID / fingerprint / passcode): when it locks, what unlocks it, and that
/// turning it on first proves the device can authenticate.
void main() {
  late _FakeAuthenticator authenticator;
  late DateTime now;
  late ProviderContainer container;

  Future<ProviderContainer> start({required bool enabled}) async {
    SharedPreferences.setMockInitialValues({'app_lock.enabled': enabled});
    container = ProviderContainer(
      overrides: [
        authStatusProvider.overrideWith((ref) => ref.watch(_statusProvider)),
        deviceAuthenticatorProvider.overrideWithValue(authenticator),
        appLockClockProvider.overrideWithValue(() => now),
      ],
    );
    addTearDown(container.dispose);
    // Kept listened to, as `AppLockGate` does: Riverpod pauses a provider nobody listens to.
    container.listen(appLockProvider, (_, _) {});
    await pumpEventQueue();
    return container;
  }

  AppLockState lock() => container.read(appLockProvider);
  AppLockController controller() => container.read(appLockProvider.notifier);

  setUp(() {
    authenticator = _FakeAuthenticator();
    now = DateTime(2026, 10, 27, 9);
  });

  test('stays unlocked when the lock is off', () async {
    await start(enabled: false);

    expect(lock().loaded, isTrue);
    expect(lock().locked, isFalse);
  });

  test('a restored session opens locked and unlocks after Face ID', () async {
    await start(enabled: true);
    expect(lock().locked, isTrue);

    authenticator.result = false;
    await controller().unlock('reason');
    expect(lock().locked, isTrue);

    authenticator.result = true;
    await controller().unlock('reason');
    expect(lock().locked, isFalse);
    expect(authenticator.prompts, 2);
  });

  test('locks again only after a minute or more in the background', () async {
    await start(enabled: true);
    await controller().unlock('reason');

    controller().onBackgrounded();
    now = now.add(const Duration(seconds: 59));
    controller().onForegrounded();
    expect(lock().locked, isFalse);

    controller().onBackgrounded();
    now = now.add(AppLockController.gracePeriod);
    controller().onForegrounded();
    expect(lock().locked, isTrue);
  });

  test('a fresh sign-in is not asked for Face ID', () async {
    await start(enabled: true);
    container.read(_statusProvider.notifier).set(AuthStatus.unauthenticated);
    await pumpEventQueue();
    container.read(_statusProvider.notifier).set(AuthStatus.authenticated);
    await pumpEventQueue();

    expect(lock().locked, isFalse);
  });

  test('turning the lock on needs a successful Face ID first', () async {
    await start(enabled: false);

    authenticator.result = false;
    expect(await controller().setEnabled(true, reason: 'reason'), isFalse);
    expect(lock().enabled, isFalse);

    authenticator.result = true;
    expect(await controller().setEnabled(true, reason: 'reason'), isTrue);
    expect(lock().enabled, isTrue);
    expect(lock().locked, isFalse);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('app_lock.enabled'), isTrue);
  });

  test('turns itself off when the phone can no longer authenticate', () async {
    await start(enabled: true);
    authenticator.available = false;

    await controller().unlock('reason');

    expect(lock().locked, isFalse);
    expect(lock().enabled, isFalse);
    expect(authenticator.prompts, 0);
  });
}

final _statusProvider = NotifierProvider<_StatusNotifier, AuthStatus>(
  _StatusNotifier.new,
);

class _StatusNotifier extends Notifier<AuthStatus> {
  @override
  AuthStatus build() => AuthStatus.authenticated;

  void set(AuthStatus status) => state = status;
}

class _FakeAuthenticator implements DeviceAuthenticator {
  bool available = true;
  bool result = true;
  int prompts = 0;

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<bool> authenticate(String reason) async {
    prompts++;
    return result;
  }
}
