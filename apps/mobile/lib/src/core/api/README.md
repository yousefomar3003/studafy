# Mobile API client

A typed [Dio](https://pub.dev/packages/dio) client for the Studafy API, generated from the OpenAPI
3.1 contract that ST-060 emits at [`apps/api/openapi.json`](../../../../../api/openapi.json) —
the Dart counterpart to [`@studafy/api-client`](../../../../../../packages/api-client/README.md)
(the TypeScript client the web app uses). Every path, parameter, request body, and response is
generated from the spec; a non-2xx response surfaces as a typed
[`ApiException`](./api_exception.dart) carrying the RFC 9457 `problem+json` fields and the
correlation `request_id`.

## Usage

```dart
import 'package:studafy_mobile/src/core/api/api_client.dart';

final api = createApiClient(
  baseUrl: Uri.parse('https://api.studafy.app'),
  getToken: () async => session.accessToken, // injects `Authorization: Bearer …`
);

try {
  final health = await api.health.getLiveness();
  print(health.status); // HealthOkStatus.ok — typed from the spec, no casts
} on DioException catch (e) {
  final apiError = e.apiError; // null for a network-level failure (no response at all)
  if (apiError != null) {
    // detail / instance / code / status / requestId are all typed and available here.
    print('${apiError.code}: ${apiError.detail ?? apiError.title} (ref ${apiError.requestId})');
  }
}
```

Every generated domain client hangs off the returned [`StudafyApiClient`](./generated/studafy_api_client.dart)
the same way — `api.students`, `api.timetable`, etc.

## Interceptors

`createApiClient` wires two Dio interceptors, in request order:

| Interceptor                                                     | What it does                                              | Enabled                     |
| ----------------------------------------------------------------| ----------------------------------------------------------| -----------------------------|
| [`AuthInterceptor`](./auth_interceptor.dart)                    | Adds `Authorization: Bearer <token>` from `getToken`       | when `getToken` is provided |
| [`ErrorMappingInterceptor`](./error_mapping_interceptor.dart)   | Attaches a typed `ApiException` to any non-2xx response    | always                      |

Nothing in this API is authenticated yet (see the OpenAPI `bearerAuth` scheme — declared, required
by no operation today), so `AuthInterceptor` is built and unit-tested but currently inert against
the live surface, exactly like the TypeScript client's own auth middleware.

## Errors — `application/problem+json`

Dio can only reject its error chain with a `DioException`, not an arbitrary object, so
`ErrorMappingInterceptor` attaches the parsed [`ApiException`](./api_exception.dart) as that
exception's `.error` field rather than throwing it directly. Read it back with the
`DioExceptionApiError.apiError` extension (shown above). It exposes:

- `status` — HTTP status.
- `code` — stable machine-readable error code, or `null` for a non-problem body. Branch on this,
  never on the localizable `title`/`detail`.
- `detail`, `instance`, `type` — RFC 9457 members (`detail` is absent on 5xx by design).
- `requestId` — the body's `request_id`, falling back to the `X-Request-Id` response header. Quote
  this to support; it correlates with server logs and the audit trail.
- `problem` — the raw parsed body, or `null` when it was not a parseable problem.

`ProblemDetails` is not a generated model: `swagger_parser` only types a client method's *success*
response, and every `problem+json` schema here is used exclusively in 4xx/5xx bodies. `ApiException`
parses the same RFC 9457 shape by hand instead — see its doc comment.

A request that never reaches the server (timeout, no connection) is left as a plain `DioException`
with no `ApiException` attached — there's no problem body to map.

## Regeneration & drift guard

The generated client is **not committed** — `lib/src/core/api/generated/` is gitignored (see the
root `.gitignore` and
[`docs/runbooks/merge-conflicts-generated-files.md`](../../../../../../docs/runbooks/merge-conflicts-generated-files.md)),
the same policy as `apps/api/openapi.json` and the TypeScript client's `generated-types.ts` — a
contract change would otherwise touch hundreds of generated files on every branch that changes a
route, which is unmergeable by construction. Regenerate it with:

```sh
bun run --cwd apps/mobile client:generate       # regenerates + formats
bun run --cwd apps/mobile client:check-drift    # fails (exit 1) if generation didn't succeed
# or, from the repo root:
bun run mobile:client:generate
bun run mobile:client:check-drift
```

`client:generate` ([`scripts/generate_api_client.sh`](../../../../scripts/generate_api_client.sh))
runs, in order: `swagger_parser generate` (OpenAPI → Dio/Retrofit client + `json_serializable`
models), two deterministic post-generation repairs (below), `build_runner build` (annotations →
the `.g.dart` serialization code), and `dart format`. CI's `mobile-api-client` job runs the same
pipeline and fails the build on a generation error, so the client can never silently drift from
the spec — see the acceptance criteria on ST-062.

### Known generation gaps

`swagger_parser` 1.44.1 (the OpenAPI → Dart generator) has three reproducible codegen bugs against
this spec. Two are repaired automatically as part of `client:generate`; the third is scoped out:

- **Missing sibling imports on `oneOf` sealed-union variants**
  ([`scripts/fix_sealed_union_imports.dart`](../../../../scripts/fix_sealed_union_imports.dart)).
  A `oneOf` variant with an inline enum property (e.g. a discriminated request body) gets a
  correctly-generated enum file that the variant's own file never imports, so it fails to
  compile. Fixed by adding the missing import — no schema semantics change.
- **Boolean single-value enums use a quoted string literal**
  ([`scripts/fix_boolean_enum_literals.dart`](../../../../scripts/fix_boolean_enum_literals.dart)).
  This API's recurring "always-true acknowledgement" idiom
  (`{"type": "boolean", "enum": [true]}` — `LogoutResult.ended`, `WebhookAccepted.ok`, …) is
  emitted as `valueTrue('true')` against a `bool?` field, which doesn't compile. Fixed by
  unquoting the literal (`@JsonValue('true')` right above it is correct as-is and untouched — see
  the script's doc comment for why).
- **`Finance` and `Approval Queue` are excluded from generation entirely** (see `pubspec.yaml`'s
  `swagger_parser.exclude_tags`). Two unrelated bugs live here that a deterministic post-generation
  fix can't safely repair: a `oneOf` request body (`FinanceExportRequest`) whose generated client
  method references the pre-union schema name instead of the actual generated class, and an
  unstable rename between two schemas that both happen to be called `Grades` (one becomes `Grades2`
  in one generated file but not in the other, breaking an interface override). Both tags are
  reachable through exactly one endpoint each today
  (`POST /api/finance/reports/export`, `GET /api/approvals/queue`); every other endpoint in the
  spec generates and compiles cleanly. Re-running `client:generate` after a `swagger_parser` bump
  is the way to find out whether either bug has been fixed upstream — if so, drop it from
  `exclude_tags`.

## Testing

`flutter test` fakes `HttpClient` process-wide (`TestWidgetsFlutterBinding` returns 400 to every
request, so ordinary widget/unit tests can't make accidental network calls) — forcing a real
`HttpClient` back in via `HttpOverrides.runZoned` deadlocks Dio inside that binding's zone (a stack
overflow in `DioMixin.fetch`, reproduced while building this client). The ST-062 acceptance test —
a real call to a live `/healthz` through this client — therefore lives outside `test/`, in
[`test_integration/`](../../../../test_integration), and runs via plain `dart test` (`bun run
--cwd apps/mobile test:integration`), which never installs that binding. See that test file's doc
comment for how to point it at a live API.
