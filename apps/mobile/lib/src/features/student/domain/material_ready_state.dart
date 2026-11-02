/// Where a material sits in the malware-scan → AI-ingestion pipeline
/// (`app.material_ingest_status`, `apps/api/src/modules/academics/schemas.ts`).
///
/// Only [ready] material can actually be opened — the storage gateway's own row-scope query
/// enforces this server-side (`RESOLVERS.material` in
/// `apps/api/src/modules/storage/download-service.ts` selects `WHERE ingest_status = 'ready'`),
/// so [isOpenable] mirrors, rather than replaces, that gate.
enum MaterialReadyState {
  /// Uploaded, waiting for the malware scan to start.
  pendingScan,

  /// Malware scan in progress.
  scanning,

  /// Scanned clean and AI-visible, waiting for AI ingestion (parse/chunk/embed) to start.
  queued,

  /// AI ingestion in progress.
  processing,

  /// Scanned clean and — if AI-visible — fully ingested. The only state the storage gateway
  /// will mint a download URL for.
  ready,

  /// Scanned clean, but AI ingestion failed. The gateway still requires `ready` to serve a
  /// download, so a failed material stays unopenable until ingestion is retried (re-toggling AI
  /// visibility server-side) and completes.
  failed,

  /// The malware scan found a threat. Never openable.
  quarantined,
}

/// Maps the wire value of a material's `ingest_status` to [MaterialReadyState].
///
/// Takes the raw string, not the generated `MaterialIngestStatus` enum, so call sites read
/// `material.ingestStatus.name` — every value here (`uploaded`, `scanning`, ...) is a single
/// word, so the generated enum's Dart member name and its wire value are identical, with no
/// snake_case-to-camelCase remapping to get wrong.
MaterialReadyState materialReadyStateFromWireName(String ingestStatus) => switch (ingestStatus) {
  'uploaded' => MaterialReadyState.pendingScan,
  'scanning' => MaterialReadyState.scanning,
  'queued' => MaterialReadyState.queued,
  'processing' => MaterialReadyState.processing,
  'ready' => MaterialReadyState.ready,
  'failed' => MaterialReadyState.failed,
  'quarantined' => MaterialReadyState.quarantined,
  // A future wire value this build doesn't know about yet. Treated as still-in-progress rather
  // than openable — the safe direction to fail in.
  _ => MaterialReadyState.processing,
};

extension MaterialReadyStateX on MaterialReadyState {
  /// Whether the storage gateway will actually resolve a download URL for a material in this
  /// state — true only for [MaterialReadyState.ready].
  bool get isOpenable => this == MaterialReadyState.ready;
}
