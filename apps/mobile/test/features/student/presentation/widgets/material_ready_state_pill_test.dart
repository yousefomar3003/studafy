import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/kit/kit.dart';
import 'package:studafy_mobile/src/features/student/domain/material_ready_state.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/material_ready_state_pill.dart';

void main() {
  test('in the pipeline is brand, ready is success, failed and blocked are danger', () {
    expect(
      {for (final state in MaterialReadyState.values) state: MaterialReadyStatePill.toneFor(state)},
      {
        MaterialReadyState.pendingScan: AppTone.brand,
        MaterialReadyState.scanning: AppTone.brand,
        MaterialReadyState.queued: AppTone.brand,
        MaterialReadyState.processing: AppTone.brand,
        MaterialReadyState.ready: AppTone.success,
        MaterialReadyState.failed: AppTone.danger,
        MaterialReadyState.quarantined: AppTone.danger,
      },
    );
  });
}
