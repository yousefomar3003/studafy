import 'package:dio/dio.dart';

/// Backend response for mobile OAuth start — PKCE params to build the
/// authorization URL.
class MobileOAuthStartResponse {
  MobileOAuthStartResponse({
    required this.state,
    required this.nonce,
    required this.codeChallenge,
  });

  factory MobileOAuthStartResponse.fromJson(Map<String, dynamic> json) {
    return MobileOAuthStartResponse(
      state: json['state'] as String,
      nonce: json['nonce'] as String,
      codeChallenge: json['code_challenge'] as String,
    );
  }

  final String state;
  final String nonce;
  final String codeChallenge;
}

/// Backend response after exchanging an authorization code for tokens.
class MobileTokenResponse {
  MobileTokenResponse({
    required this.accessToken,
    required this.tokenType,
    required this.expiresIn,
    required this.sessionId,
    this.refreshToken,
  });

  factory MobileTokenResponse.fromJson(Map<String, dynamic> json) {
    return MobileTokenResponse(
      accessToken: json['access_token'] as String,
      tokenType: json['token_type'] as String,
      expiresIn: json['expires_in'] as int,
      sessionId: json['session_id'] as String,
      refreshToken: json['refresh_token'] as String?,
    );
  }

  final String accessToken;
  final String tokenType;
  final int expiresIn;
  final String sessionId;
  final String? refreshToken;
}

/// Thin HTTP client for the mobile OAuth endpoints. Uses plain [Dio] rather
/// than the generated Retrofit client — these two endpoints aren't in the
/// OpenAPI-generated client yet and the surface is trivial.
class MobileAuthClient {
  MobileAuthClient({required String baseUrl, Dio? dio})
      : _dio = dio ?? Dio(BaseOptions(baseUrl: baseUrl));

  final Dio _dio;

  /// Fetch PKCE parameters for a provider's mobile flow.
  Future<MobileOAuthStartResponse> startOAuth(String provider) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/api/auth/oauth/$provider/mobile-start',
    );
    return MobileOAuthStartResponse.fromJson(response.data!);
  }

  /// Exchange an authorization code for session tokens.
  Future<MobileTokenResponse> exchangeCode({
    required String provider,
    required String code,
    required String state,
    required String nonce,
    required String codeVerifier,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/auth/oauth/$provider/mobile-exchange',
      data: {
        'code': code,
        'state': state,
        'nonce': nonce,
        'code_verifier': codeVerifier,
      },
    );
    return MobileTokenResponse.fromJson(response.data!);
  }

  /// Rotate a refresh token. Returns the new token pair.
  Future<MobileTokenResponse> refreshSession(String refreshToken) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/auth/refresh',
      data: {'refresh_token': refreshToken},
    );
    return MobileTokenResponse.fromJson(response.data!);
  }

  /// Revoke the session. Always succeeds (200) per backend contract.
  Future<void> logout(String refreshToken) async {
    await _dio.post<dynamic>(
      '/api/auth/logout',
      data: {'refresh_token': refreshToken},
    );
  }
}
