import XCTest

/// ST-247: the XCUITest entry point `integration_test` needs on iOS — for both a local
/// `flutter test integration_test/` run against a simulator and Firebase Test Lab's
/// `gcloud firebase test ios run`. Like `android/app/src/androidTest/.../MainActivityTest.kt`, this
/// carries no assertions of its own: `integration_test`'s Dart-side binding registers the real test
/// body (the `integration_test/*.dart` file compiled in for this run) as the thing
/// `testLaunchApp` hands control to once the app launches.
///
/// This file alone is not enough to build and run — a `RunnerUITests` UI Testing Bundle target
/// must exist in Runner.xcodeproj with this file added to it and the Runner scheme's Test action
/// pointed at it. That is a one-time step for whoever has Xcode installed; see
/// `docs/testing/mobile-integration-suite.md`'s "iOS test target" section for exactly what to
/// click through. Hand-editing project.pbxproj blind (no Xcode available to verify it) is a good
/// way to silently corrupt a working project file, so this repo does not attempt that here.
final class RunnerUITests: XCTestCase {
    func testLaunchApp() throws {
        let app = XCUIApplication()
        app.launch()
    }
}
