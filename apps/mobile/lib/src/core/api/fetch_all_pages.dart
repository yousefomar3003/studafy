/// The largest page the API's offset-paginated list endpoints accept. Larger `limit` values are
/// rejected with a 400, not clamped (see `apps/api/src/modules/academics/schemas.ts`).
const apiMaxPageSize = 100;

/// Collects every row of an offset-paginated list by requesting [apiMaxPageSize]-row pages until
/// [total] is reached or a short page comes back.
///
/// [fetchPage] receives `(limit, offset)` and returns that page's rows plus the endpoint's
/// reported `total`. [maxPages] guards against a server that keeps returning full pages.
Future<List<T>> fetchAllPages<T>(
  Future<({List<T> rows, int total})> Function(int limit, int offset)
  fetchPage, {
  int maxPages = 50,
}) async {
  final all = <T>[];
  for (var page = 0; page < maxPages; page++) {
    final result = await fetchPage(apiMaxPageSize, all.length);
    all.addAll(result.rows);
    if (result.rows.length < apiMaxPageSize || all.length >= result.total) {
      break;
    }
  }
  return all;
}
