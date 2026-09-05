plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    id("com.google.gms.google-services")
    // Uploads the ProGuard/R8 mapping file on release builds so obfuscated Crashlytics stack
    // traces get symbolicated — see docs/monitoring.md.
    id("com.google.firebase.crashlytics")
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

    buildTypes {
        release {
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
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
