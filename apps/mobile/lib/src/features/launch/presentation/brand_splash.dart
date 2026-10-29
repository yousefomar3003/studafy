import 'package:flutter/material.dart';

/// The splash artwork's navy. Mirrored in the native launch screens, so the handoff from the
/// OS splash to this one is invisible: `ios/Runner/Base.lproj/LaunchScreen.storyboard` and
/// `android/app/src/main/res/values/colors.xml` (`launch_navy`).
const brandNavy = Color(0xFF161551);

/// The white wordmark centred on navy, sized to the screen the same way the iOS launch screen
/// sizes it: 62% of the width, at most 420 points, so it reads well on a phone and on an iPad in
/// either orientation.
class BrandSplash extends StatelessWidget {
  const BrandSplash({super.key});

  static double wordmarkWidth(Size screen) =>
      (screen.width * 0.62).clamp(0, 420);

  @override
  Widget build(BuildContext context) {
    final width = wordmarkWidth(MediaQuery.sizeOf(context));
    return ColoredBox(
      color: brandNavy,
      child: Center(
        child: TweenAnimationBuilder<double>(
          // A slow settle from the native splash's exact size, so the wordmark feels alive
          // without jumping when Flutter takes over.
          tween: Tween(begin: 1, end: 1.04),
          duration: const Duration(milliseconds: 1600),
          curve: Curves.easeOutCubic,
          builder: (context, scale, child) =>
              Transform.scale(scale: scale, child: child),
          child: Image.asset(
            'assets/brand/studafy-wordmark-white.png',
            width: width,
            semanticLabel: 'Studafy',
            filterQuality: FilterQuality.medium,
          ),
        ),
      ),
    );
  }
}
