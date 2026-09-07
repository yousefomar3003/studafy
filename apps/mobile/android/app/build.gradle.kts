import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    id("com.google.gms.google-services")
    // Uploads the ProGuard/R8 mapping file on release builds so obfuscated Crashlytics stack
    // traces get symbolicated — see docs/monitoring.md.
    id("com.google.firebase.crashlytics")
}

// Play upload-key material (ST-257). `android/key.properties` is written at release time by
// `fastlane android signing` from CI secrets and is gitignored — it never exists on a dev machine
// or in the repo. When it is absent every build falls back to the debug keystore, so
// `flutter run --release` and CI test builds keep working untouched. Google's Play App Signing
// re-signs the uploaded bundle with the real distribution key on its side; this is only the
// upload key. See docs/runbooks/mobile-release.md#android-signing.
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        FileInputStream(keystorePropertiesFile).use { load(it) }
    }
}

android {
    namespace = "com.studafy.studafy_mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        resValues = true
    }

    defaultConfig {
        applicationId = "com.studafy.studafy_mobile"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        // ST-247: lets `integration_test/` build an androidTest APK (`assemble<Flavor>DebugAndroidTest`)
        // for `flutter test integration_test/` and for Firebase Test Lab's `gcloud firebase test
        // android run --type instrumentation`. See src/androidTest/.../MainActivityTest.kt.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    flavorDimensions += "environment"

    productFlavors {
        create("dev") {
            dimension = "environment"
            applicationIdSuffix = ".dev"
            resValue("string", "app_name", "Studafy Dev")
        }
        create("staging") {
            dimension = "environment"
            applicationIdSuffix = ".staging"
            resValue("string", "app_name", "Studafy Staging")
        }
        create("prod") {
            dimension = "environment"
            resValue("string", "app_name", "Studafy")
        }
    }

    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            // The real upload key when fastlane has provisioned key.properties (CI release lane);
            // the debug keystore otherwise, so `flutter run --release` and CI test builds still work.
            signingConfig = if (keystorePropertiesFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    // ST-247: instrumentation-runner deps for the androidTest APK integration_test builds. Pinned
    // to the same androidx.test major line Flutter's own integration_test package targets.
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
