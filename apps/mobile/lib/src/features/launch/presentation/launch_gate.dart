import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../application/launch_intro.dart';
import 'brand_splash.dart';
import 'launch_guide.dart';

enum _Phase { splash, guide, app }

/// Covers the app with the brand splash for a moment at launch, then the first-run guide when
/// [launchIntroProvider] asks for it, then fades away.
///
/// The app is built underneath the whole time (pointer- and semantics-blocked), so the login
/// screen or the restored session's home is already laid out when the cover lifts.
///
/// Mount it inside `MaterialApp.builder`, below `LocaleRebuildScope` so the guide's strings
/// follow a locale change.
class LaunchGate extends ConsumerStatefulWidget {
  const LaunchGate({required this.child, super.key});

  final Widget child;

  static const splashDuration = Duration(milliseconds: 1600);

  @override
  ConsumerState<LaunchGate> createState() => _LaunchGateState();
}

class _LaunchGateState extends ConsumerState<LaunchGate> {
  late _Phase _phase;
  late final bool _showGuide;
  Timer? _splashTimer;

  @override
  void initState() {
    super.initState();
    final intro = ref.read(launchIntroProvider);
    _showGuide = intro == LaunchIntro.splashThenGuide;
    _phase = intro == LaunchIntro.none ? _Phase.app : _Phase.splash;
    if (_phase == _Phase.splash) {
      _splashTimer = Timer(LaunchGate.splashDuration, () {
        if (!mounted) return;
        setState(() => _phase = _showGuide ? _Phase.guide : _Phase.app);
      });
    }
  }

  @override
  void dispose() {
    _splashTimer?.cancel();
    super.dispose();
  }

  void _finishGuide() {
    if (_phase != _Phase.guide) return;
    unawaited(markLaunchGuideSeen());
    setState(() => _phase = _Phase.app);
  }

  @override
  Widget build(BuildContext context) {
    final covered = _phase != _Phase.app;
    return Stack(
      fit: StackFit.expand,
      children: [
        IgnorePointer(
          ignoring: covered,
          child: ExcludeSemantics(excluding: covered, child: widget.child),
        ),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 450),
          switchInCurve: Curves.easeOut,
          switchOutCurve: Curves.easeIn,
          child: switch (_phase) {
            _Phase.splash => const _Cover(
              key: ValueKey(_Phase.splash),
              child: BrandSplash(),
            ),
            _Phase.guide => _Cover(
              key: const ValueKey(_Phase.guide),
              child: LaunchGuide(onDone: _finishGuide),
            ),
            _Phase.app => const SizedBox.shrink(key: ValueKey(_Phase.app)),
          },
        ),
      ],
    );
  }
}

/// White status-bar icons over the navy, and a Material ancestor for the guide's text and buttons.
class _Cover extends StatelessWidget {
  const _Cover({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Material(color: brandNavy, child: child),
    );
  }
}
