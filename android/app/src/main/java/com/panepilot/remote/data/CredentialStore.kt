package com.panepilot.remote.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.ByteBuffer
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class CredentialStore(context: Context) {
    private val preferences =
        context.getSharedPreferences("panepilot_remote_credentials", Context.MODE_PRIVATE)

    @Synchronized
    fun password(profileId: String): String? {
        val encoded = preferences.getString(profileId, null) ?: return null
        return runCatching {
            val payload = Base64.getDecoder().decode(encoded)
            require(payload.size >= MIN_PAYLOAD_BYTES)
            val buffer = ByteBuffer.wrap(payload)
            val ivLength = buffer.int
            require(ivLength in 12..32 && buffer.remaining() > ivLength)
            val iv = ByteArray(ivLength).also { buffer.get(it) }
            val ciphertext = ByteArray(buffer.remaining()).also { buffer.get(it) }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(128, iv))
            cipher.updateAAD(profileId.toByteArray())
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        }.getOrNull()?.takeIf { it.isNotEmpty() }
    }

    @Synchronized
    fun savePassword(profileId: String, password: String) {
        require(password.isNotEmpty())
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        cipher.updateAAD(profileId.toByteArray())
        val ciphertext = cipher.doFinal(password.toByteArray())
        val payload = ByteBuffer.allocate(Int.SIZE_BYTES + cipher.iv.size + ciphertext.size)
            .putInt(cipher.iv.size)
            .put(cipher.iv)
            .put(ciphertext)
            .array()
        preferences.edit()
            .putString(profileId, Base64.getEncoder().encodeToString(payload))
            .apply()
    }

    @Synchronized
    fun remove(profileId: String) {
        preferences.edit().remove(profileId).apply()
    }

    private fun encryptionKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            .apply {
                init(
                    KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build()
                )
            }
            .generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "panepilot-remote-credentials-v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val MIN_PAYLOAD_BYTES = Int.SIZE_BYTES + 12 + 16
    }
}
