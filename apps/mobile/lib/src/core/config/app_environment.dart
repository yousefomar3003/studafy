enum AppEnvironment {
  // The realtime gateway (`apps/realtime`) runs standalone on its own port (3001) in dev, behind
  // the same Android-emulator loopback alias as the API. In staging/prod it is planned to share
  // the API's ALB origin via `/ws` path routing (see
  // `infra/terraform/modules/monitoring/variables.tf`'s `realtime_ws_url`), so those default to
  // the same host as `defaultApiBaseUrl` with the scheme swapped for `ws`/`wss`.
  dev(
    label: 'Development',
    shortName: 'dev',
    defaultApiBaseUrl: 'http://10.0.2.2:3000',
    defaultRealtimeBaseUrl: 'ws://10.0.2.2:3001',
  ),
  staging(
    label: 'Staging',
    shortName: 'staging',
    defaultApiBaseUrl: 'https://staging-api.studafy.com',
    defaultRealtimeBaseUrl: 'wss://staging-api.studafy.com',
  ),
  prod(
    label: 'Production',
    shortName: 'prod',
    defaultApiBaseUrl: 'https://api.studafy.com',
    defaultRealtimeBaseUrl: 'wss://api.studafy.com',
  );

  const AppEnvironment({
    required this.label,
    required this.shortName,
    required this.defaultApiBaseUrl,
    required this.defaultRealtimeBaseUrl,
  });

  final String label;
  final String shortName;
  final String defaultApiBaseUrl;
  final String defaultRealtimeBaseUrl;
}
