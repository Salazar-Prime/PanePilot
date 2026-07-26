package com.panepilot.remote.ssh

import android.content.Context
import android.os.SystemClock
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Session
import com.jcraft.jsch.UserInfo
import com.panepilot.remote.data.ProfileStore
import com.panepilot.remote.model.AuthMode
import com.panepilot.remote.model.ConnectionSecret
import com.panepilot.remote.model.ServerProfile
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File

data class CommandResult(
    val stdout: String,
    val stderr: String,
    val exitCode: Int
)

class SshConnection(
    context: Context,
    private val profileStore: ProfileStore,
    private val confirmHostKey: (String) -> Boolean
) {
    private val knownHostsFile = File(context.filesDir, "known_hosts").apply {
        parentFile?.mkdirs()
        if (!exists()) createNewFile()
    }

    @Volatile
    private var session: Session? = null

    @Volatile
    private var hostKeyRejectedByUser = false

    val isConnected: Boolean
        get() = session?.isConnected == true

    @Synchronized
    fun connect(profile: ServerProfile, secret: ConnectionSecret) {
        disconnect()
        hostKeyRejectedByUser = false
        val jsch = JSch()
        jsch.setKnownHosts(knownHostsFile.absolutePath)

        when (profile.authMode) {
            AuthMode.PASSWORD -> {
                require(secret.password.isNotEmpty()) { "Enter the SSH password." }
            }

            AuthMode.PRIVATE_KEY -> {
                val privateKey = profileStore.privateKey(profile.id)
                    ?: throw IllegalArgumentException(
                        "Import a private key before connecting to this server."
                    )
                val passphrase =
                    secret.keyPassphrase.takeIf { it.isNotEmpty() }?.toByteArray()
                try {
                    jsch.addIdentity(profile.name, privateKey, null, passphrase)
                } finally {
                    privateKey.fill(0)
                    passphrase?.fill(0)
                }
            }
        }

        val next = jsch.getSession(profile.username, profile.host, profile.port)
        if (profile.authMode == AuthMode.PASSWORD) {
            next.setPassword(secret.password.toByteArray())
        }
        next.setConfig(
            "PreferredAuthentications",
            if (profile.authMode == AuthMode.PASSWORD) {
                "password,keyboard-interactive"
            } else {
                "publickey"
            }
        )
        next.setConfig("StrictHostKeyChecking", "ask")
        next.userInfo = object : UserInfo {
            override fun getPassword(): String? = null
            override fun getPassphrase(): String? = null
            override fun promptPassword(message: String?): Boolean = false
            override fun promptPassphrase(message: String?): Boolean = false
            override fun showMessage(message: String?) = Unit

            override fun promptYesNo(message: String?): Boolean {
                val prompt = message.orEmpty()
                if (
                    prompt.contains("REMOTE HOST IDENTIFICATION HAS CHANGED", ignoreCase = true) ||
                    prompt.contains("host key has changed", ignoreCase = true)
                ) {
                    return false
                }
                return confirmHostKey(prompt).also { accepted ->
                    if (!accepted) hostKeyRejectedByUser = true
                }
            }
        }
        next.setServerAliveInterval(15_000)
        next.setServerAliveCountMax(3)

        try {
            next.connect(CONNECT_TIMEOUT_MS)
            session = next
        } catch (error: Exception) {
            next.disconnect()
            throw connectionError(error)
        }
    }

    @Synchronized
    fun disconnect() {
        session?.disconnect()
        session = null
    }

    @Synchronized
    fun execute(
        command: String,
        stdin: ByteArray? = null,
        timeoutMs: Long = COMMAND_TIMEOUT_MS,
        maxOutputBytes: Int = MAX_COMMAND_OUTPUT
    ): CommandResult {
        val active = session?.takeIf { it.isConnected }
            ?: throw IllegalStateException("The SSH connection is offline.")
        val channel = active.openChannel("exec") as ChannelExec
        val stdout = channel.inputStream
        val stderr = ByteArrayOutputStream()
        val stdoutBytes = ByteArrayOutputStream()

        channel.setCommand(command)
        channel.setPty(false)
        channel.setErrStream(stderr)
        if (stdin != null) {
            channel.setInputStream(ByteArrayInputStream(stdin))
        } else {
            channel.setInputStream(null)
        }

        val startedAt = SystemClock.elapsedRealtime()
        try {
            channel.connect(CONNECT_TIMEOUT_MS)
            val buffer = ByteArray(8_192)
            while (!channel.isClosed || stdout.available() > 0) {
                while (stdout.available() > 0) {
                    val count = stdout.read(buffer, 0, minOf(buffer.size, stdout.available()))
                    if (count < 0) break
                    if (stdoutBytes.size() + count > maxOutputBytes) {
                        throw IllegalStateException("The server returned more data than this view allows.")
                    }
                    stdoutBytes.write(buffer, 0, count)
                }
                if (stderr.size() > maxOutputBytes) {
                    throw IllegalStateException("The server returned an oversized error.")
                }
                if (SystemClock.elapsedRealtime() - startedAt > timeoutMs) {
                    throw IllegalStateException("The remote command timed out.")
                }
                if (!channel.isClosed) Thread.sleep(20)
            }
            return CommandResult(
                stdout = stdoutBytes.toString(Charsets.UTF_8.name()),
                stderr = stderr.toString(Charsets.UTF_8.name()),
                exitCode = channel.exitStatus
            )
        } catch (error: JSchException) {
            throw connectionError(error)
        } finally {
            channel.disconnect()
        }
    }

    @Synchronized
    fun forgetHostKey(profile: ServerProfile) {
        val jsch = JSch()
        jsch.setKnownHosts(knownHostsFile.absolutePath)
        val host = if (profile.port == 22) profile.host else "[${profile.host}]:${profile.port}"
        jsch.hostKeyRepository.remove(host, null)
    }

    private fun connectionError(error: Exception): Exception {
        val detail = error.message.orEmpty()
        return when {
            detail.contains("reject HostKey", ignoreCase = true) && hostKeyRejectedByUser ->
                IllegalStateException("The SSH host key was not trusted. Connection cancelled.")

            detail.contains("reject HostKey", ignoreCase = true) ->
                IllegalStateException(
                    "The saved SSH host key does not match. Verify the server, then forget " +
                        "its saved host key from Edit server before trying again."
                )

            detail.contains("Auth fail", ignoreCase = true) ->
                IllegalStateException("SSH authentication failed. Check the username and credentials.")

            detail.contains("timeout", ignoreCase = true) ->
                IllegalStateException("The SSH server did not respond in time.")

            else -> IllegalStateException(detail.ifBlank { "The SSH connection failed." })
        }
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 10_000
        const val COMMAND_TIMEOUT_MS = 12_000L
        const val MAX_COMMAND_OUTPUT = 1_048_576
    }
}
