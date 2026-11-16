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

  // A notification that arrives while the app is open on screen. iOS shows it only if this
  // delegate answers with presentation options. The firebase_messaging plugin is meant to answer
  // (setForegroundNotificationPresentationOptions in push_service.dart), but registered through the
  // implicit engine it did not, so nothing was shown while the app was open, though the same push
  // appeared on the lock screen. Still hand it on (the plugin's onMessage refreshes the in-app
  // bell), then always answer with a banner, once, whoever answers first.
  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let show: UNNotificationPresentationOptions = [.banner, .list, .sound, .badge]
    var answered = false
    let answer: (UNNotificationPresentationOptions) -> Void = { _ in
      DispatchQueue.main.async {
        guard !answered else { return }
        answered = true
        completionHandler(show)
      }
    }
    super.userNotificationCenter(center, willPresent: notification, withCompletionHandler: answer)
    answer(show)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }
}
