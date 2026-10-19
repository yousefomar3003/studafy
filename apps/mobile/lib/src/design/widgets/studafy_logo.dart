import 'package:flutter/material.dart';

/// The navy Studafy wordmark — the same asset the web shows on light surfaces
/// (`apps/web/src/assets/studafy-logo-navy.png`, `BrandLogo tone="navy"`).
///
/// "Studafy" is a proper noun, so the semantic label is never translated.
class StudafyLogo extends StatelessWidget {
  const StudafyLogo({this.height = 28, super.key});

  /// Rendered height; the width follows the asset's 387×120 aspect ratio.
  final double height;

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/brand/studafy-logo-navy.png',
      height: height,
      semanticLabel: 'Studafy',
      filterQuality: FilterQuality.medium,
    );
  }
}
