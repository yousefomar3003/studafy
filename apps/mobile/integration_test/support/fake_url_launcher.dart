import 'package:url_launcher_platform_interface/link.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

/// Records every `launchUrl` call instead of actually opening a browser.
///
/// [AiUpsellCard] calls the top-level `launchUrl` function, which delegates to
/// `UrlLauncherPlatform.instance` — the one platform-channel seam `url_launcher` exposes for
/// exactly this kind of substitution, the same technique the package's own tests use. This lets
/// the AI-upsell journey assert on the real widget's real button real tapping through to a real
/// `Uri` without an actual system browser popping up mid-suite (which would strand the test with
/// no way to bring the app back to the foreground).
class FakeUrlLauncher extends UrlLauncherPlatform {
  final launches = <String>[];

  @override
  LinkDelegate? get linkDelegate => null;

  @override
  Future<bool> canLaunch(String url) async => true;

  @override
  Future<bool> launchUrl(String url, LaunchOptions options) async {
    launches.add(url);
    return true;
  }
}
