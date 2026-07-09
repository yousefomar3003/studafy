import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/app.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/di/app_providers.dart';

void main() {
  testWidgets('boots the development app shell', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          appConfigProvider.overrideWithValue(
            AppConfig.fromEnvironment(AppEnvironment.dev),
          ),
        ],
        child: const StudafyApp(),
      ),
    );

    expect(find.text('Studafy'), findsOneWidget);
    expect(find.text('Mobile shell'), findsOneWidget);
    expect(find.text('Development'), findsOneWidget);
    expect(find.text('http://10.0.2.2:3000'), findsOneWidget);
  });
}
