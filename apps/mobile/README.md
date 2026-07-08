# @studafy/mobile

Studafy's Flutter mobile application shell. It contains the bootstrap needed for future product work: flavors, explicit app configuration, `go_router`, Riverpod providers, lightweight dependency injection, and a feature-first folder structure.

## Requirements

- Flutter stable with Dart `^3.12.2`
- Android SDK for Android builds
- Xcode on macOS for iOS builds

This workstation also has Flutter available at `C:\tmp\flutter`; the commands below use plain `flutter` so they work once Flutter is on `PATH`.

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

| Flavor    | Default API base URL              |
| --------- | --------------------------------- |
| `dev`     | `http://10.0.2.2:3000`            |
| `staging` | `https://staging-api.studafy.com` |
| `prod`    | `https://api.studafy.com`         |

Override any flavor at build or run time with `API_BASE_URL`:

```powershell
flutter run --flavor dev -t lib/main_dev.dart --dart-define=API_BASE_URL=http://localhost:3000
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

Add concrete service providers only when a real service exists. Keep providers explicit and feature-local unless they are needed app-wide.

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
