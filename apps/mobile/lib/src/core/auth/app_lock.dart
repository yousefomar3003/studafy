import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'auth_notifier.dart';
import 'auth_state.dart';

/// The device's own unlock: Face ID / Touch ID on iOS, fingerprint or face unlock on Android,
/// falling back to the device passcode, PIN or pattern. Nothing leaves the device — the OS only
/// answers whether the person holding the phone unlocked it.
class DeviceAuthenticator {
  DeviceAuthenticator({LocalAuthentication? auth})
    : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  /// Whether this device has biometrics or at least a passcode set up to ask for.
  Future<bool> isAvailable() async {
    try {
      return await _auth.isDeviceSupported();
    } on PlatformException {
      return false;
    } on LocalAuthException {
      return false;
    }
  }

  /// Shows the system prompt. `false` when the person cancels or fails it.
  Future<bool> authenticate(String reason) async {
    try {
      return await _auth.authenticate(
        localizedReason: reason,
        // The prompt survives the app being briefly backgrounded instead of failing.
        persistAcrossBackgrounding: true,
      );
    } on PlatformException {
      return false;
    } on LocalAuthException {
      return false;
    }
  }
}

/// Whether this device asks for Face ID / fingerprint / passcode before showing Studafy. A plain
/// SharedPreferences flag: it is a preference, not a secret, and is wiped with the app.
class AppLockPreferences {
  static const _keyEnabled = 'app_lock.enabled';

  Future<bool> isEnabled() async =>
      (await SharedPreferences.getInstance()).getBool(_keyEnabled) ?? false;

  Future<void> setEnabled(bool enabled) async =>
      (await SharedPreferences.getInstance()).setBool(_keyEnabled, enabled);
}

class AppLockState {
  const AppLockState({
    required this.loaded,
    required this.enabled,
    required this.locked,
  });

  /// `false` until the preference has been read; the app stays covered meanwhile.
  final bool loaded;
  final bool enabled;
  final bool locked;

  AppLockState copyWith({bool? loaded, bool? enabled, bool? locked}) =>
      AppLockState(
        loaded: loaded ?? this.loaded,
        enabled: enabled ?? this.enabled,
        locked: locked ?? this.locked,
      );
}

final deviceAuthenticatorProvider = Provider<DeviceAuthenticator>(
  (ref) => DeviceAuthenticator(),
);

final appLockPreferencesProvider = Provider<AppLockPreferences>(
  (ref) => AppLockPreferences(),
);

/// The clock the lock measures time in the background with; overridden in tests.
final appLockClockProvider = Provider<DateTime Function()>(
  (ref) => DateTime.now,
);

/// Device-level app lock. When enabled, a restored session opens locked, and the app locks again
/// after spending [gracePeriod] or longer in the background. A fresh sign-in does not lock: the
/// person just proved who they are.
///
/// Only the UI is covered — the session, tokens and every screen's state stay as they were, so
/// unlocking returns exactly where the person left off.
class AppLockController extends Notifier<AppLockState> {
  /// Long enough that picking a file or photo, or a quick switch to another app, doesn't ask
  /// again on return.
  static const gracePeriod = Duration(minutes: 1);

  DateTime? _backgroundedAt;
  bool _authenticating = false;

  @override
  AppLockState build() {
    // Signed out, there is nothing to cover; the next sign-in then lands unlocked.
    ref.listen<AuthStatus>(authStatusProvider, (previous, next) {
      if (next == AuthStatus.unauthenticated) {
        state = state.copyWith(locked: false);
      }
    });
    _load();
    return const AppLockState(loaded: false, enabled: false, locked: true);
  }

  Future<void> _load() async {
    final enabled = await ref.read(appLockPreferencesProvider).isEnabled();
    final signedOut =
        ref.read(authStatusProvider) == AuthStatus.unauthenticated;
    state = AppLockState(
      loaded: true,
      enabled: enabled,
      locked: enabled && !signedOut,
    );
  }

  void onBackgrounded() {
    if (_authenticating) return;
    _backgroundedAt = ref.read(appLockClockProvider)();
  }

  void onForegrounded() {
    final since = _backgroundedAt;
    _backgroundedAt = null;
    if (!state.enabled || since == null) return;
    final away = ref.read(appLockClockProvider)().difference(since);
    if (away >= gracePeriod) state = state.copyWith(locked: true);
  }

  /// Asks for Face ID / fingerprint / passcode and unlocks on success. If the device can no
  /// longer authenticate (its passcode was removed), the lock has nothing to ask for: it turns
  /// itself off rather than shutting the person out.
  Future<void> unlock(String reason) async {
    if (!state.locked || _authenticating) return;
    final authenticator = ref.read(deviceAuthenticatorProvider);
    _authenticating = true;
    try {
      if (!await authenticator.isAvailable()) {
        await ref.read(appLockPreferencesProvider).setEnabled(false);
        state = state.copyWith(enabled: false, locked: false);
        return;
      }
      if (await authenticator.authenticate(reason)) {
        state = state.copyWith(locked: false);
      }
    } finally {
      _authenticating = false;
    }
  }

  /// Turning the lock on asks for Face ID / fingerprint first, so it is only enabled once it is
  /// known to work. Returns whether the lock is now in the requested state.
  Future<bool> setEnabled(bool enabled, {required String reason}) async {
    if (enabled) {
      final authenticator = ref.read(deviceAuthenticatorProvider);
      if (!await authenticator.isAvailable()) return false;
      _authenticating = true;
      try {
        if (!await authenticator.authenticate(reason)) return false;
      } finally {
        _authenticating = false;
      }
    }
    await ref.read(appLockPreferencesProvider).setEnabled(enabled);
    state = state.copyWith(enabled: enabled, locked: false);
    return true;
  }
}

final appLockProvider = NotifierProvider<AppLockController, AppLockState>(
  AppLockController.new,
);

/// Whether this device can offer the app lock at all (biometrics or a passcode is set up).
final appLockAvailableProvider = FutureProvider.autoDispose<bool>(
  (ref) => ref.read(deviceAuthenticatorProvider).isAvailable(),
);
