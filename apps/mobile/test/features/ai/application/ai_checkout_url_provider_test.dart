import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/di/app_providers.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_hub_providers.dart';
import 'package:studafy_mobile/src/features/student/application/student_context_providers.dart';

AppConfig _config({String aiAddonPriceId = 'price-1'}) {
  return AppConfig(
    environment: AppEnvironment.dev,
    apiBaseUrl: Uri.parse('http://10.0.2.2:3000'),
    realtimeBaseUrl: Uri.parse('ws://10.0.2.2:3001'),
    webBaseUrl: Uri.parse('https://app.studafy.com'),
    aiAddonPriceId: aiAddonPriceId,
  );
}

void main() {
  group('aiCheckoutUrlProvider', () {
    test('builds the checkout link once both the student id and price id are known', () {
      final container = ProviderContainer(
        overrides: [
          appConfigProvider.overrideWithValue(_config()),
          currentStudentIdProvider.overrideWithValue('student-1'),
        ],
      );
      addTearDown(container.dispose);

      final url = container.read(aiCheckoutUrlProvider);

      expect(url, isNotNull);
      expect(url!.path, '/account/ai');
      expect(url.queryParameters, {'studentId': 'student-1', 'priceId': 'price-1'});
    });

    test('is null when the student id cannot be resolved', () {
      final container = ProviderContainer(
        overrides: [appConfigProvider.overrideWithValue(_config())],
      );
      addTearDown(container.dispose);

      expect(container.read(aiCheckoutUrlProvider), isNull);
    });

    test('is null when this build has no AI add-on price id configured', () {
      final container = ProviderContainer(
        overrides: [
          appConfigProvider.overrideWithValue(_config(aiAddonPriceId: '')),
          currentStudentIdProvider.overrideWithValue('student-1'),
        ],
      );
      addTearDown(container.dispose);

      expect(container.read(aiCheckoutUrlProvider), isNull);
    });
  });
}
