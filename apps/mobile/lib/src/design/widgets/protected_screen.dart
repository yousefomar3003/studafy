import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Wraps a screen that shows grades, marks or transcripts (QA-084).
///
/// - **Android:** while any [ProtectedScreen] is mounted, the window carries `FLAG_SECURE`
///   (set in `MainActivity.kt`): screenshots and screen recordings come out black, and the
///   recent-apps thumbnail is blank.
/// - **Every platform:** while the app is not in the foreground, the content is covered, so the
///   app-switcher snapshot (which iOS takes as the app goes inactive) never shows it.
///
/// Several can be mounted at once (a pushed screen over another); protection stays on until the
/// last one is gone.
class ProtectedScreen extends StatefulWidget {
  const ProtectedScreen({required this.child, super.key});

  final Widget child;

  /// Handled by `MainActivity.kt` on Android; not registered on iOS, where the cover does the job.
  static const channel = MethodChannel('studafy/screen_protection');

  @visibleForTesting
  static const coverKey = Key('protected-screen-cover');

  static int _mounted = 0;

  static Future<void> _setSecure(bool secure) async {
    try {
      await channel.invokeMethod<void>('setSecure', secure);
    } on MissingPluginException {
      // iOS and tests without a handler: nothing to set.
    } on PlatformException {
      // Best-effort: the cover below still hides the content from the app switcher.
    }
  }

  @override
  State<ProtectedScreen> createState() => _ProtectedScreenState();
}

class _ProtectedScreenState extends State<ProtectedScreen> {
  late final AppLifecycleListener _lifecycle;
  bool _covered = false;

  @override
  void initState() {
    super.initState();
    if (ProtectedScreen._mounted++ == 0) ProtectedScreen._setSecure(true);
    _lifecycle = AppLifecycleListener(onStateChange: _onLifecycle);
  }

  void _onLifecycle(AppLifecycleState state) {
    final covered = state != AppLifecycleState.resumed;
    if (covered != _covered) setState(() => _covered = covered);
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    if (--ProtectedScreen._mounted == 0) ProtectedScreen._setSecure(false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        widget.child,
        if (_covered)
          Positioned.fill(
            child: ColoredBox(
              key: ProtectedScreen.coverKey,
              color: Theme.of(context).colorScheme.surface,
            ),
          ),
      ],
    );
  }
}
