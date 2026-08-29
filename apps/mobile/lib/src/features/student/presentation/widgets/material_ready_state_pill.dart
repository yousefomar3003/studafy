import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../domain/material_ready_state.dart';
import 'status_pill.dart';

/// A [StatusPill] for a material's position in the malware-scan → AI-ingestion pipeline — the
/// ready-state awareness the class materials list and the viewer screen both need before letting
/// a student open or download a file.
class MaterialReadyStatePill extends StatelessWidget {
  const MaterialReadyStatePill({required this.state, super.key});

  final MaterialReadyState state;

  @override
  Widget build(BuildContext context) =>
      StatusPill(label: labelKeyFor(state).tr(), tone: toneFor(state));

  static String labelKeyFor(MaterialReadyState state) => switch (state) {
    MaterialReadyState.pendingScan => 'materials.status.pendingScan',
    MaterialReadyState.scanning => 'materials.status.scanning',
    MaterialReadyState.queued => 'materials.status.queued',
    MaterialReadyState.processing => 'materials.status.processing',
    MaterialReadyState.ready => 'materials.status.ready',
    MaterialReadyState.failed => 'materials.status.failed',
    MaterialReadyState.quarantined => 'materials.status.quarantined',
  };

  static StatusPillTone toneFor(MaterialReadyState state) => switch (state) {
    MaterialReadyState.ready => StatusPillTone.success,
    MaterialReadyState.pendingScan ||
    MaterialReadyState.scanning ||
    MaterialReadyState.queued ||
    MaterialReadyState.processing => StatusPillTone.neutral,
    MaterialReadyState.failed || MaterialReadyState.quarantined => StatusPillTone.danger,
  };
}
