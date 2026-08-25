# @studafy/mobile

Studafy's Flutter mobile application shell. It contains the bootstrap needed for future product work: flavors, explicit app configuration, `go_router`, Riverpod providers, lightweight dependency injection, and a feature-first folder structure.

## Requirements

- Flutter stable with Dart `^3.12.2`
- Android SDK for Android builds
- Xcode on macOS for iOS builds

The commands below use plain `flutter`; make sure the Flutter SDK is on `PATH`.

## Running Flavors

Each environment has a Dart entrypoint and platform flavor.

```powershell
flutter run --flavor dev -t lib/main_dev.dart
flutter run --flavor staging -t lib/main_staging.dart
flutter run --flavor prod -t lib/main_prod.dart
```

Build Android debug variants with:

```powershell
flutter build apk --debug --flavor dev -t lib/main_dev.dart
flutter build apk --debug --flavor staging -t lib/main_staging.dart
flutter build apk --debug --flavor prod -t lib/main_prod.dart
```

From the monorepo root, Turbo can run mobile tasks through the `@studafy/mobile` workspace:

```powershell
bun run lint
bun run typecheck
bun run test
bun run build
```

## API Configuration

Flavor defaults live in `lib/src/core/config/app_environment.dart`.

| Flavor    | Default API base URL              | Default realtime base URL       |
| --------- | ---------------------------------- | -------------------------------- |
| `dev`     | `http://10.0.2.2:3000`            | `ws://10.0.2.2:3001`             |
| `staging` | `https://staging-api.studafy.com` | `wss://staging-api.studafy.com` |
| `prod`    | `https://api.studafy.com`         | `wss://api.studafy.com`         |

Override any flavor at build or run time with `API_BASE_URL` / `REALTIME_BASE_URL`:

```powershell
flutter run --flavor dev -t lib/main_dev.dart --dart-define=API_BASE_URL=http://localhost:3000 --dart-define=REALTIME_BASE_URL=ws://localhost:3001
```

## Folder Structure

```text
lib/
  main_dev.dart
  main_staging.dart
  main_prod.dart
  src/
    app.dart
    core/
      config/
      di/
      network/
      realtime/
      router/
      utils/
    design/
      colors/
      theme/
      typography/
      widgets/
    features/
      home/
        presentation/
```

Feature code belongs under `lib/src/features/<feature_name>/`. Shared app wiring belongs in `core/`, and reusable visual primitives belong in `design/`.

## Router

Routes are created in `lib/src/core/router/app_router.dart` with `go_router`. The shell currently exposes `/`, mapped to the home feature. Add new path constants to `route_paths.dart` and register routes in `createAppRouter`.

## Riverpod and DI

`ProviderScope` is configured in `app_bootstrap.dart`. App-wide dependencies are centralized in `core/di/app_providers.dart`:

- `appConfigProvider` exposes the selected flavor and API base URL.
- `networkConfigProvider` exposes network configuration for future API clients.
- `routerProvider` creates the app router.

Add concrete service providers only when a real service exists. Keep providers explicit and feature-local unless they are needed app-wide. `core/realtime/realtime_providers.dart` follows this same rule for the realtime client (see below) rather than adding it to `app_providers.dart`, matching how the generated API client (`core/api/`) is also consumed directly by feature code instead of being centralized there.

## Realtime client

`core/realtime/` implements the WebSocket client for the gateway (`apps/realtime`), a Dart port of `apps/web/src/lib/realtime/`:

| Module                  | Responsibility                                                        |
| ------------------------ | ---------------------------------------------------------------------- |
| `protocol.dart`          | Wire grammar (`EventEnvelope`, system messages), close code 4401.      |
| `realtime_socket.dart`   | `RealtimeSocket`: transport seam wrapping `web_socket_channel`.        |
| `backoff.dart`           | Pure jittered-backoff delay computation.                               |
| `realtime_client.dart`   | `RealtimeClient`: auth, reconnect, room rejoin, app-lifecycle handling.|
| `realtime_providers.dart`| Riverpod wiring: token seam, the client itself, status/event streams.  |

`realtimeClientProvider` constructs one `RealtimeClient` per app instance and connects it immediately. No session/auth feature exists yet, so `realtimeTokenProvider` resolves no token by default (the client sits `unauthorized`, same as being signed out) — override it once a session store lands, the same way `appConfigProvider` is overridden today.

### Background/foreground handling

`RealtimeClient` observes app lifecycle transitions directly (via an injectable `AppLifecycleObserver` seam, real implementation backed by `AppLifecycleListener`): backgrounding tears the socket down without scheduling a reconnect, and resuming reconnects immediately. Because the reconnect path is the same one used for a dropped connection, this also reconciles: `realtimeConnectionStatusProvider` reports a `connected -> idle -> connected` transition either way.

### Reconciling feature state

Unlike the web client, `RealtimeClient` does not own a query-invalidation map — Riverpod providers invalidate themselves. A feature provider integrates with two streams from `realtime_providers.dart`:

```dart
ref.listen(realtimeEventsProvider, (previous, next) {
  if (next.valueOrNull?.type == 'grades.published') {
    ref.invalidateSelf();
  }
});
```

and, to cover a gap while the socket was down (a reconnect or a background/foreground cycle):

```dart
ref.listen(realtimeConnectionStatusProvider, (previous, next) {
  if (previous != null && previous != RealtimeConnectionStatus.connected &&
      next == RealtimeConnectionStatus.connected) {
    ref.invalidateSelf();
  }
});
```

## Platform Flavors

- Android product flavors are defined in `android/app/build.gradle.kts`.
- iOS shared schemes are defined for `dev`, `staging`, and `prod`, with flavor-specific build configurations and display names.
- Full iOS build validation requires Xcode on macOS.

## Development Workflow

```powershell
flutter pub get
flutter analyze
flutter test
```
