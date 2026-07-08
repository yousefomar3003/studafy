enum AppEnvironment {
  dev(
    label: 'Development',
    shortName: 'dev',
    defaultApiBaseUrl: 'http://10.0.2.2:3000',
  ),
  staging(
    label: 'Staging',
    shortName: 'staging',
    defaultApiBaseUrl: 'https://staging-api.studafy.com',
  ),
  prod(
    label: 'Production',
    shortName: 'prod',
    defaultApiBaseUrl: 'https://api.studafy.com',
  );

  const AppEnvironment({
    required this.label,
    required this.shortName,
    required this.defaultApiBaseUrl,
  });

  final String label;
  final String shortName;
  final String defaultApiBaseUrl;
}
