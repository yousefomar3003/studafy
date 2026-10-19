import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/pump_studafy_app.dart';

void main() {
  testWidgets('unauthenticated session lands on the login screen', (tester) async {
    await pumpStudafyApp(tester);

    expect(find.byKey(const Key('brandLogo')), findsOneWidget);
    expect(find.byKey(const Key('memberSignInUsername')), findsOneWidget);
    // Mobile is member ID + password only; Google/Microsoft and email sign-in are not offered.
    expect(find.text('Sign in with email'), findsNothing);
    expect(find.text('Sign in with Microsoft'), findsNothing);
    expect(find.text('Sign in with Google'), findsNothing);
    expect(find.text('Privacy policy'), findsOneWidget);
  });
}
