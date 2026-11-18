import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/student_ai_providers.dart';
import 'package:studafy_mobile/src/features/parent/data/student_ai_client.dart';
import 'package:studafy_mobile/src/features/parent/domain/student_ai_offer.dart';

import '../student_ai_fixtures.dart';

/// A parent with children at two schools has an account per school. Each school's offers come
/// from that account's own session, so switching accounts must load the new school's offers rather
/// than keep showing the previous one's.
class _AccountClient extends Fake implements StudentAiClient {
  _AccountClient(this.byAccount, this.activeAccount);

  final Map<String, StudentAiOffers> byAccount;
  final String? Function() activeAccount;
  final List<String?> fetchedFor = [];

  @override
  Future<StudentAiOffers> fetchOffers() async {
    final account = activeAccount();
    fetchedFor.add(account);
    return byAccount[account]!;
  }
}

class _Account extends Notifier<String?> {
  @override
  String? build() => 'parent-at-alpha';

  void set(String? userId) => state = userId;
}

final _accountProvider = NotifierProvider<_Account, String?>(_Account.new);

void main() {
  test("switching accounts loads the other school's offers", () async {
    late ProviderContainer container;
    final client = _AccountClient({
      'parent-at-alpha': offersOf([availableOfferJson(id: 'child-1', name: 'Amir')]),
      'parent-at-beta': offersOf([closedOfferJson(id: 'child-2', name: 'Lina')]),
    }, () => container.read(_accountProvider));

    container = ProviderContainer(
      overrides: [
        studentAiClientProvider.overrideWithValue(client),
        authStatusProvider.overrideWith(
          (ref) => ref.watch(_accountProvider) == null
              ? AuthStatus.unauthenticated
              : AuthStatus.authenticated,
        ),
        parentUserIdProvider.overrideWith((ref) => ref.watch(_accountProvider)),
      ],
    );
    addTearDown(container.dispose);
    final sub = container.listen(studentAiOffersProvider, (_, _) {});
    addTearDown(sub.close);

    final alpha = await container.read(studentAiOffersProvider.future);
    expect(alpha!.offers.single.studentName, 'Amir');

    container.read(_accountProvider.notifier).set('parent-at-beta');
    final beta = await container.read(studentAiOffersProvider.future);
    expect(beta!.offers.single.studentName, 'Lina');
    expect(client.fetchedFor, ['parent-at-alpha', 'parent-at-beta']);

    container.read(_accountProvider.notifier).set(null);
    expect(await container.read(studentAiOffersProvider.future), isNull);
    expect(client.fetchedFor, hasLength(2));
  });

  test('null window, period and opt-in parse (closed and confirmed offers)', () {
    final offers = offersOf([
      closedOfferJson(id: 'child-1', name: 'Amir'),
      optedInOfferJson(
        id: 'child-2',
        name: 'Lina',
        source: 'school_on_behalf',
        waitingForSchool: true,
      ),
    ]);
    expect(offers.schoolName, 'Alpha Academy');

    final closed = offers.offers.first;
    expect(closed.state, StudentAiOfferState.closed);
    expect(closed.window, isNull);
    expect(closed.period, isNull);
    expect(closed.canOptIn, isFalse);

    final optedIn = offers.offers.last;
    expect(optedIn.optIn!.source, StudentAiOptInSource.schoolOnBehalf);
    expect(optedIn.optIn!.waitingForSeat, isTrue);
  });
}
