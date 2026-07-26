package com.panepilot.remote.data

import android.content.Context
import android.net.Uri
import com.panepilot.remote.model.AuthMode
import com.panepilot.remote.model.ServerProfile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class ProfileStore(private val context: Context) {
    private val preferences =
        context.getSharedPreferences("panepilot_remote_profiles", Context.MODE_PRIVATE)
    private val keyDirectory = File(context.filesDir, "ssh-keys").apply { mkdirs() }

    fun load(): List<ServerProfile> {
        val raw = preferences.getString(PROFILES_KEY, null) ?: return emptyList()
        return runCatching {
            val array = JSONArray(raw)
            buildList {
                for (index in 0 until array.length()) {
                    val item = array.getJSONObject(index)
                    add(
                        ServerProfile(
                            id = item.getString("id"),
                            name = item.getString("name"),
                            host = item.getString("host"),
                            port = item.optInt("port", 22),
                            username = item.getString("username"),
                            authMode = AuthMode.valueOf(item.getString("authMode")),
                            keyDisplayName = item.optString("keyDisplayName")
                                .takeIf { it.isNotBlank() }
                        )
                    )
                }
            }
        }.getOrDefault(emptyList())
    }

    fun save(profile: ServerProfile, selectedKey: Uri?): List<ServerProfile> {
        if (selectedKey != null) {
            importPrivateKey(profile.id, selectedKey)
        }
        val profiles = load().filterNot { it.id == profile.id } + profile
        persist(profiles.sortedBy { it.name.lowercase() })
        return profiles.sortedBy { it.name.lowercase() }
    }

    fun delete(profileId: String): List<ServerProfile> {
        keyFile(profileId).delete()
        return load().filterNot { it.id == profileId }.also(::persist)
    }

    fun privateKey(profileId: String): ByteArray? {
        val file = keyFile(profileId)
        if (!file.isFile || file.length() !in 1..MAX_KEY_BYTES) return null
        return file.readBytes()
    }

    fun hasPrivateKey(profileId: String): Boolean {
        val file = keyFile(profileId)
        return file.isFile && file.length() in 1..MAX_KEY_BYTES
    }

    private fun importPrivateKey(profileId: String, uri: Uri) {
        val target = keyFile(profileId)
        val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8_192)
            while (output.size() < MAX_KEY_BYTES + 1) {
                val count = input.read(
                    buffer,
                    0,
                    minOf(buffer.size, MAX_KEY_BYTES + 1 - output.size())
                )
                if (count < 0) break
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } ?: throw IllegalArgumentException("The selected private key could not be read.")
        require(bytes.isNotEmpty()) { "The selected private key is empty." }
        require(bytes.size <= MAX_KEY_BYTES) { "Private keys must be smaller than 1 MB." }

        val temporary = File(keyDirectory, ".$profileId.tmp")
        temporary.outputStream().use { it.write(bytes) }
        runCatching {
            Files.move(
                temporary.toPath(),
                target.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE
            )
        }.recoverCatching {
            Files.move(
                temporary.toPath(),
                target.toPath(),
                StandardCopyOption.REPLACE_EXISTING
            )
        }.getOrElse {
            temporary.delete()
            throw IllegalStateException("The private key could not be stored.", it)
        }
    }

    private fun keyFile(profileId: String) = File(keyDirectory, "$profileId.key")

    private fun persist(profiles: List<ServerProfile>) {
        val array = JSONArray()
        profiles.forEach { profile ->
            array.put(
                JSONObject()
                    .put("id", profile.id)
                    .put("name", profile.name)
                    .put("host", profile.host)
                    .put("port", profile.port)
                    .put("username", profile.username)
                    .put("authMode", profile.authMode.name)
                    .put("keyDisplayName", profile.keyDisplayName ?: "")
            )
        }
        preferences.edit().putString(PROFILES_KEY, array.toString()).apply()
    }

    private companion object {
        const val PROFILES_KEY = "profiles"
        const val MAX_KEY_BYTES = 1_048_576
    }
}
