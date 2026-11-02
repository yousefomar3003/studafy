import 'package:flutter/material.dart';

/// The navy Studafy wordmark — the same asset the web shows on light surfaces
/// (`apps/web/src/assets/studafy-logo-navy.png`, `BrandLogo tone="navy"`).
///
/// [StudafyLogo.subscriber] is the subscriber brand instead: the navy "S" with the gold star.
///
/// "Studafy" is a proper noun, so the semantic label is never translated.
class StudafyLogo extends StatelessWidget {
  const StudafyLogo({this.height = 28, super.key}) : subscriber = false;

  const StudafyLogo.subscriber({this.height = 36, super.key})
    : subscriber = true;

  /// Rendered height; the width follows the asset's aspect ratio (387×120 for the wordmark,
  /// 345×360 for the subscriber mark).
  final double height;

  final bool subscriber;

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      subscriber
          ? 'assets/brand/studafy-mark-plus.png'
          : 'assets/brand/studafy-logo-navy.png',
      height: height,
      semanticLabel: 'Studafy',
      filterQuality: FilterQuality.medium,
    );
  }
}
