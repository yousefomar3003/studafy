/// Where a [CachedValue] came from.
enum CacheSource {
  /// Read straight from a live API response.
  network,

  /// Read from the offline cache because there either was no live response yet, or the most
  /// recent attempt to get one failed (e.g. no connectivity).
  cache,
}

/// A resource value alongside when it was fetched and whether it's live or cached.
class CachedValue<T> {
  const CachedValue({required this.data, required this.fetchedAt, required this.source});

  final T data;
  final DateTime fetchedAt;
  final CacheSource source;

  /// Whether this value should be shown with a staleness indicator — true whenever it wasn't
  /// just confirmed against the server, regardless of how recently it was.
  bool get isStale => source == CacheSource.cache;
}
