import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/kit/kit.dart';
import 'package:studafy_mobile/src/design/tokens/app_color_tokens.dart';

/// WCAG 2.x contrast ratio between two opaque colours.
double contrast(Color a, Color b) {
  final la = a.computeLuminance();
  final lb = b.computeLuminance();
  return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
}

void main() {
  const aa = 4.5;

  group('AppAccent palette meets WCAG AA (4.5:1) for text', () {
    for (final accent in AppAccent.values) {
      for (final brightness in Brightness.values) {
        test('${accent.name} (${brightness.name})', () {
          final colors = accent.resolve(brightness);
          expect(
            contrast(colors.onSolid, colors.solid),
            greaterThanOrEqualTo(aa),
            reason: 'onSolid on solid',
          );
          expect(
            contrast(colors.onContainer, colors.container),
            greaterThanOrEqualTo(aa),
            reason: 'onContainer on container',
          );
        });
      }
    }
  });

  test(
    'every hero gradient stop holds 4.5:1 against the hero\'s white text',
    () {
      for (final accent in AppAccent.values) {
        for (final stop in AppHeroCard.gradientFor(accent)) {
          expect(
            contrast(AppHeroCard.foreground, stop),
            greaterThanOrEqualTo(aa),
            reason: '${accent.name} stop $stop',
          );
        }
      }
    },
  );

  test('the blue accent is the brand blue, so tinted UI matches the theme', () {
    expect(AppAccent.blue.light.solid, AppColorTokens.accent600);
    expect(AppTone.brand.accent, AppAccent.blue);
  });

  test('subject hues leave out the status colours', () {
    expect(AppAccent.subjectHues, isNot(contains(AppAccent.red)));
    expect(AppAccent.subjectHues, isNot(contains(AppAccent.green)));
    expect(AppAccent.subjectHues, isNot(contains(AppAccent.slate)));
  });

  test('AppTone.forPercentage bands marks', () {
    expect(AppTone.forPercentage(null), AppTone.neutral);
    expect(AppTone.forPercentage(92), AppTone.success);
    expect(AppTone.forPercentage(85), AppTone.success);
    expect(AppTone.forPercentage(74), AppTone.brand);
    expect(AppTone.forPercentage(58), AppTone.warning);
    expect(AppTone.forPercentage(12), AppTone.danger);
  });
}
