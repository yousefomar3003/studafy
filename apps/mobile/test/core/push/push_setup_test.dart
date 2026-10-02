import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/push/push_providers.dart';

import '../../support/fake_push_service.dart';

void main() {
  ProviderContainer containerWith(FakePushService push) {
    final container = ProviderContainer(
      overrides: [pushServiceProvider.overrideWithValue(push)],
    );
    addTearDown(container.dispose);
    addTearDown(push.dispose);
    return container;
  }

  test('an unanswered OS prompt waits for the explanation instead of showing it cold', () async {
    final push = FakePushService(permissionUnanswered: true);
    final container = containerWith(push);

    await container.read(pushSetupProvider.notifier).initialize();

    expect(container.read(pushSetupProvider), PushSetup.needsPermission);
    expect(push.permissionRequests, 0);

    await container.read(pushSetupProvider.notifier).requestPermission();

    expect(container.read(pushSetupProvider), PushSetup.done);
    expect(push.permissionRequests, 1);
  });

  test('an answered OS prompt finishes setup without asking again', () async {
    final push = FakePushService();
    final container = containerWith(push);

    await container.read(pushSetupProvider.notifier).initialize();
    await container.read(pushSetupProvider.notifier).requestPermission();

    expect(container.read(pushSetupProvider), PushSetup.done);
    expect(push.permissionRequests, 0);
  });

  test('initialize runs once per app session', () async {
    final push = FakePushService(permissionUnanswered: true);
    final container = containerWith(push);
    final notifier = container.read(pushSetupProvider.notifier);

    await notifier.initialize();
    await notifier.requestPermission();
    await notifier.initialize();

    expect(container.read(pushSetupProvider), PushSetup.done);
    expect(push.permissionRequests, 1);
  });

  test('a failing push stack leaves setup done, not stuck', () async {
    final container = containerWith(_ThrowingPushService());

    await container.read(pushSetupProvider.notifier).initialize();

    expect(container.read(pushSetupProvider), PushSetup.done);
  });
}

class _ThrowingPushService extends FakePushService {
  @override
  Future<String?> initialize() => Future.error(StateError('no Firebase app'));
}
