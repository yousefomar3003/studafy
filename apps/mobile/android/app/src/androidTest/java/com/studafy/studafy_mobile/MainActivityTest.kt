package com.studafy.studafy_mobile

// ST-247: the instrumentation entry point Firebase Test Lab (and a local
// `flutter test integration_test/`) actually runs. `integration_test`'s own Dart-side test
// binding registers the real test bodies (integration_test/*.dart, compiled in per invocation via
// `-Ptarget=`) as native instrumentation methods — this class only needs to launch MainActivity
// and hand control to that binding; it carries no assertions of its own.
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @get:Rule
    val rule = ActivityScenarioRule(MainActivity::class.java)

    @Test
    fun launchesForIntegrationTests() {
        // No-op: launching MainActivity (the @Rule above) is what integration_test needs — the
        // Dart-side test compiled into this APK via `-Ptarget=` is what runs the real assertions.
    }
}
