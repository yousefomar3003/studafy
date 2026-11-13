import Flutter
import FirebaseCore
import FirebaseMessaging
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // GoogleService-Info.plist is not committed (see docs/monitoring.md); without it,
    // configure() raises, so local builds skip Firebase (push, Crashlytics) instead of crashing.
    if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
      FirebaseApp.configure()

      // Push has to be wired here, not left to the firebase_messaging plugin. With the UIScene
      // lifecycle the plugins are registered when the scene's engine starts
      // (didInitializeImplicitFlutterEngine), which is after launch has finished, so the plugin
      // never sees UIApplicationDidFinishLaunching: it never calls registerForRemoteNotifications,
      // the phone never receives an APNs token, FCM never issues a token, and no notification
      // can reach an iPhone. So: take the notification-center delegate (FlutterAppDelegate
      // forwards its callbacks to the plugins once they register), ask APNs for a token now, and
      // hand that token to FCM ourselves in didRegisterForRemoteNotificationsWithDeviceToken.
      UNUserNotificationCenter.current().delegate = self
      application.registerForRemoteNotifications()
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    if FirebaseApp.app() != nil {
      Messaging.messaging().apnsToken = deviceToken
    }
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }
}
