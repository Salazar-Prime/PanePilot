package com.panepilot.remote.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class CredentialStoreTest {
    @Test
    fun encryptsAndRemovesRememberedPassword() {
        val store = CredentialStore(ApplicationProvider.getApplicationContext())
        val profileId = "test-${UUID.randomUUID()}"

        try {
            store.savePassword(profileId, "temporary-test-password")
            assertEquals("temporary-test-password", store.password(profileId))
        } finally {
            store.remove(profileId)
        }

        assertNull(store.password(profileId))
    }
}
