import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_checkout_link.dart';

void main() {
  final webBaseUrl = Uri.parse('https://app.studafy.com');

  group('buildAiCheckoutUrl', () {
    test('builds /account/ai with studentId and priceId as query params', () {
      final url = buildAiCheckoutUrl(
        webBaseUrl: webBaseUrl,
        studentId: 'student-1',
        aiAddonPriceId: 'price-1',
      );

      expect(url, isNotNull);
      expect(url!.scheme, 'https');
      expect(url.host, 'app.studafy.com');
      expect(url.path, '/account/ai');
      expect(url.queryParameters, {'studentId': 'student-1', 'priceId': 'price-1'});
    });

    test('is null when studentId is unresolved', () {
      final url = buildAiCheckoutUrl(
        webBaseUrl: webBaseUrl,
        studentId: null,
        aiAddonPriceId: 'price-1',
      );

      expect(url, isNull);
    });

    test('is null when studentId is empty', () {
      final url = buildAiCheckoutUrl(
        webBaseUrl: webBaseUrl,
        studentId: '',
        aiAddonPriceId: 'price-1',
      );

      expect(url, isNull);
    });

    test('is null when the AI add-on price id is not configured', () {
      final url = buildAiCheckoutUrl(
        webBaseUrl: webBaseUrl,
        studentId: 'student-1',
        aiAddonPriceId: '',
      );

      expect(url, isNull);
    });
  });
}
