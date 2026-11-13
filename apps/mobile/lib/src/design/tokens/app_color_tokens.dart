import 'package:flutter/painting.dart';

/// Corporate Precision — raw color scale.
///
/// Canonical source: `packages/ui/src/theme.ts` (`color`). Mirrored here value-for-value;
/// if a hex changes there, change it here too. Nothing outside `design/` should reference
/// these directly — bind to [AppColorScheme] or [AppSemanticColors] instead, same rule the
/// web tokens use for `semanticColor` over `color`.
abstract final class AppColorTokens {
  static const white = Color(0xFFFFFFFF);
  static const black = Color(0xFF000000);

  // Cool-slate neutral scale — the structural backbone (surfaces, text, borders).
  static const neutral50 = Color(0xFFF8FAFC);
  static const neutral100 = Color(0xFFF1F5F9);
  static const neutral200 = Color(0xFFE2E8F0);
  static const neutral300 = Color(0xFFCBD5E1);
  static const neutral400 = Color(0xFF94A3B8);
  static const neutral500 = Color(0xFF64748B);
  static const neutral600 = Color(0xFF475569);
  static const neutral700 = Color(0xFF334155);
  static const neutral800 = Color(0xFF1E293B);
  static const neutral900 = Color(0xFF0F172A);
  static const neutral950 = Color(0xFF020617);

  // Precision blue — the single brand/action accent.
  static const accent50 = Color(0xFFEFF6FF);
  static const accent100 = Color(0xFFDBEAFE);
  static const accent200 = Color(0xFFBFDBFE);
  static const accent300 = Color(0xFF93C5FD);
  static const accent400 = Color(0xFF60A5FA);
  static const accent500 = Color(0xFF3B82F6);
  static const accent600 = Color(0xFF2563EB);
  static const accent700 = Color(0xFF1D4ED8);
  static const accent800 = Color(0xFF1E40AF);
  static const accent900 = Color(0xFF1E3A8A);
  static const accent950 = Color(0xFF172554);

  static const success50 = Color(0xFFF0FDF4);
  static const success100 = Color(0xFFDCFCE7);
  static const success400 = Color(0xFF4ADE80);
  static const success600 = Color(0xFF16A34A);
  static const success700 = Color(0xFF15803D);
  static const success800 = Color(0xFF166534);

  static const danger50 = Color(0xFFFEF2F2);
  static const danger100 = Color(0xFFFEE2E2);
  static const danger400 = Color(0xFFF87171);
  static const danger600 = Color(0xFFDC2626);
  static const danger700 = Color(0xFFB91C1C);
  static const danger800 = Color(0xFF991B1B);

  static const warning50 = Color(0xFFFFFBEB);
  static const warning100 = Color(0xFFFEF9C3);
  static const warning400 = Color(0xFFFACC15);
  static const warning700 = Color(0xFFA16207);
  static const warning800 = Color(0xFF854D0E);
}
