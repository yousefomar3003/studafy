import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../app.dart';
import '../di/app_providers.dart';
import 'app_config.dart';
import 'app_environment.dart';

void bootstrapApp(AppEnvironment environment) {
  WidgetsFlutterBinding.ensureInitialized();

  // Inter ships as a bundled asset (see pubspec.yaml + assets/fonts/), so the app never
  // depends on a network fetch to render its own type scale.
  GoogleFonts.config.allowRuntimeFetching = false;

  runApp(
    ProviderScope(
      overrides: [
        appConfigProvider.overrideWithValue(
          AppConfig.fromEnvironment(environment),
        ),
      ],
      child: const StudafyApp(),
    ),
  );
}
