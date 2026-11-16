import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/kit/kit.dart';
import '../../domain/material_ready_state.dart';

/// An [AppStatusPill] for a material's position in the malware-scan → AI-ingestion pipeline — the
/// ready-state awareness the class materials list and the viewer screen both need before letting
/// a student open or download a file.
///
/// Still in the pipeline is the brand tone, ready is success, and failed or blocked is danger.
class MaterialReadyStatePill extends StatelessWidget {
  const MaterialReadyStatePill({required this.state, super.key});

  final MaterialReadyState state;

  @override
  Widget build(BuildContext context) =>
      AppStatusPill(label: labelKeyFor(state).tr(), tone: toneFor(state), icon: iconFor(state));

  static String labelKeyFor(MaterialReadyState state) => switch (state) {
    MaterialReadyState.pendingScan => 'materials.status.pendingScan',
    MaterialReadyState.scanning => 'materials.status.scanning',
    MaterialReadyState.queued => 'materials.status.queued',
    MaterialReadyState.processing => 'materials.status.processing',
    MaterialReadyState.ready => 'materials.status.ready',
    MaterialReadyState.failed => 'materials.status.failed',
    MaterialReadyState.quarantined => 'materials.status.quarantined',
  };

  static AppTone toneFor(MaterialReadyState state) => switch (state) {
    MaterialReadyState.ready => AppTone.success,
    MaterialReadyState.pendingScan ||
    MaterialReadyState.scanning ||
    MaterialReadyState.queued ||
    MaterialReadyState.processing => AppTone.brand,
    MaterialReadyState.failed || MaterialReadyState.quarantined => AppTone.danger,
  };

  static IconData iconFor(MaterialReadyState state) => switch (state) {
    MaterialReadyState.ready => Icons.check_circle_outline,
    MaterialReadyState.pendingScan ||
    MaterialReadyState.scanning ||
    MaterialReadyState.queued ||
    MaterialReadyState.processing => Icons.hourglass_top,
    MaterialReadyState.failed => Icons.error_outline,
    MaterialReadyState.quarantined => Icons.gpp_bad_outlined,
  };
}
