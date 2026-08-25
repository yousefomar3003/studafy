/// Auth state machine for the app.
enum AuthStatus {
  /// Restoring session from secure storage, or refreshing tokens.
  loading,

  /// User is not authenticated — show login.
  unauthenticated,

  /// User is authenticated — show home.
  authenticated,
}
