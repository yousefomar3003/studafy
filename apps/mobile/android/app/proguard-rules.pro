# App-level R8 rules for release builds. The Flutter Gradle plugin adds this file to the release
# build type automatically (next to proguard-android-optimize.txt and Flutter's own rules) whenever
# it exists, so it needs no line in build.gradle.kts.

# --- Firebase component registrars -------------------------------------------------------------
# Firebase finds its SDKs by class name (meta-data in the merged manifest) and creates each
# ComponentRegistrar through its no-argument constructor, by reflection. firebase-components ships
# only `-keep class * implements ComponentRegistrar`, which in R8 full mode (the default since
# AGP 8, and what AGP 9 builds this app with) keeps the class but NOT its constructor. R8 then
# removed the constructors of CrashlyticsRegistrar, FirebaseMessagingKtxRegistrar and
# FirebaseInstallationsKtxRegistrar, so on a release build the Crashlytics component never
# registered and `Firebase.initializeApp()` failed on Android with
# "FirebaseCrashlytics component is not present" (firebase_core asks every Firebase plugin for its
# constants while initialising). Push then reported "Not available in this version of the app",
# no FCM token was ever registered, and Crashlytics could not report it. iOS is unaffected (no R8).
-keep class * implements com.google.firebase.components.ComponentRegistrar {
    public <init>();
}

# --- flutter_local_notifications (Gson) --------------------------------------------------------
# The plugin stores scheduled notifications as JSON through Gson's TypeToken, which needs the
# generic signatures R8 full mode strips ("Missing type parameter"). The app does not schedule
# notifications today, so this is not what broke push; it keeps a future use from failing only in
# release builds. These are the rules the plugin's README asks apps to add.
-keepattributes Signature
-keep class com.google.gson.reflect.TypeToken { *; }
-keep class * extends com.google.gson.reflect.TypeToken
-keep class com.dexterous.flutterlocalnotifications.models.** { *; }
