import 'package:flutter_test/flutter_test.dart';

import 'support/pump_studafy_app.dart';

void main() {
  testWidgets('unauthenticated session lands on the login screen', (tester) async {
    await pumpStudafyApp(tester);

    expect(find.text('Studafy'), findsOneWidget);
    expect(find.text('Sign in with Microsoft'), findsOneWidget);
    expect(find.text('Sign in with Google'), findsOneWidget);
  });
}
