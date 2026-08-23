import 'package:flutter/painting.dart';

/// Corporate Precision — corner radius scale.
///
/// Canonical source: `packages/ui/src/theme.ts` (`radius`).
abstract final class AppRadius {
  static const double none = 0;
  static const double sm = 4;
  static const double md = 8;
  static const double lg = 12;
  static const double xl = 16;

  /// Large enough to render as a fully-rounded ("pill") edge at any control height.
  static const double full = 9999;

  static const BorderRadius noneRadius = BorderRadius.zero;
  static const BorderRadius smRadius = BorderRadius.all(Radius.circular(sm));
  static const BorderRadius mdRadius = BorderRadius.all(Radius.circular(md));
  static const BorderRadius lgRadius = BorderRadius.all(Radius.circular(lg));
  static const BorderRadius xlRadius = BorderRadius.all(Radius.circular(xl));
  static const BorderRadius fullRadius = BorderRadius.all(Radius.circular(full));
}
