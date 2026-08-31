enum AppEnvironment {
  // The realtime gateway (`apps/realtime`) runs standalone on its own port (3001) in dev, behind
  // the same Android-emulator loopback alias as the API. In staging/prod it is planned to share
  // the API's ALB origin via `/ws` path routing (see
  // `infra/terraform/modules/monitoring/variables.tf`'s `realtime_ws_url`), so those default to
  // the same host as `defaultApiBaseUrl` with the scheme swapped for `ws`/`wss`.
  // defaultWebBaseUrl follows the same convention infra/terraform/modules/edge/dns.tf documents
  // for defaultApiBaseUrl: app.studafy.com / staging.studafy.com are the real apps/web hostnames
  // (infra/terraform/variables.tf's cdn_domain_name), so hardcoding them here carries no more risk
  // than the API host already does. Dev has no emulator alias to reach for — apps/web runs on the
  // host machine's Vite dev server (default port 5173), which the Android emulator's loopback
  // alias (10.0.2.2) reaches the same way it reaches the API on 10.0.2.2:3000.
  dev(
    label: 'Development',
    shortName: 'dev',
    defaultApiBaseUrl: 'http://10.0.2.2:3000',
    defaultRealtimeBaseUrl: 'ws://10.0.2.2:3001',
    defaultWebBaseUrl: 'http://10.0.2.2:5173',
  ),
  staging(
    label: 'Staging',
    shortName: 'staging',
    defaultApiBaseUrl: 'https://staging-api.studafy.com',
    defaultRealtimeBaseUrl: 'wss://staging-api.studafy.com',
    defaultWebBaseUrl: 'https://staging.studafy.com',
  ),
  prod(
    label: 'Production',
    shortName: 'prod',
    defaultApiBaseUrl: 'https://api.studafy.com',
    defaultRealtimeBaseUrl: 'wss://api.studafy.com',
    defaultWebBaseUrl: 'https://app.studafy.com',
  );

  const AppEnvironment({
    required this.label,
    required this.shortName,
    required this.defaultApiBaseUrl,
    required this.defaultRealtimeBaseUrl,
    required this.defaultWebBaseUrl,
  });

  final String label;
  final String shortName;
  final String defaultApiBaseUrl;
  final String defaultRealtimeBaseUrl;
  final String defaultWebBaseUrl;
}
