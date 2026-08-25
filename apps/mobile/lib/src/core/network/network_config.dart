class NetworkConfig {
  const NetworkConfig({
    required this.apiBaseUrl,
    required this.realtimeBaseUrl,
  });

  final Uri apiBaseUrl;
  final Uri realtimeBaseUrl;
}
