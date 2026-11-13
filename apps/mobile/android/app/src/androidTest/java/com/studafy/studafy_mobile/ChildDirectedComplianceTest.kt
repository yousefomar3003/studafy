package com.studafy.studafy_mobile

// ST-307: checks the installed APK — the real merged manifest, every transitive AAR included —
// against Google Play's Families data practices. Firebase Test Lab runs it alongside the
// integration_test journeys (Pixel 7, API 34). See docs/sdk_compliance_inventory.md.
import android.content.pm.PackageManager
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.ads.identifier.AdvertisingIdClient
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ChildDirectedComplianceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun targetsApi33OrHigher() {
        assertTrue(context.applicationInfo.targetSdkVersion >= 33)
    }

    @Test
    fun requestsNoPermissionThatExposesARestrictedIdentifier() {
        val requested = context.packageManager
            .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions
            .orEmpty()
            .toSet()

        assertEquals(emptySet<String>(), requested intersect RESTRICTED_IDENTIFIER_PERMISSIONS)
    }

    @Test
    fun advertisingIdIsZeroed() {
        // Zeroing is enforced by Google Play services for apps targeting API 33+ on Android 13+.
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        assumeTrue(
            GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) ==
                ConnectionResult.SUCCESS,
        )

        val info = AdvertisingIdClient.getAdvertisingIdInfo(context)

        assertEquals(ZEROED_AAID, info.id)
    }

    private companion object {
        const val ZEROED_AAID = "00000000-0000-0000-0000-000000000000"

        // The permissions an app needs to read the identifiers Play's Families policy forbids
        // transmitting from children or unknown-age users: AAID, SIM/build serial, IMEI/IMSI
        // (phone state), and BSSID/SSID (Wi-Fi state plus location). MAC has no permission path on
        // API 30+ — the platform returns a constant.
        val RESTRICTED_IDENTIFIER_PERMISSIONS = setOf(
            "com.google.android.gms.permission.AD_ID",
            "android.permission.READ_PHONE_STATE",
            "android.permission.READ_PRIVILEGED_PHONE_STATE",
            "android.permission.READ_PHONE_NUMBERS",
            "android.permission.ACCESS_WIFI_STATE",
            "android.permission.ACCESS_FINE_LOCATION",
            "android.permission.ACCESS_COARSE_LOCATION",
            "android.permission.NEARBY_WIFI_DEVICES",
        )
    }
}
