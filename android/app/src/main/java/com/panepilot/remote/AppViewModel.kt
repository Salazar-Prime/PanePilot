package com.panepilot.remote

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.panepilot.remote.data.ProfileStore
import com.panepilot.remote.model.AuthMode
import com.panepilot.remote.model.ConnectionSecret
import com.panepilot.remote.model.PanePilotSession
import com.panepilot.remote.model.ServerProfile
import com.panepilot.remote.ssh.SshConnection
import com.panepilot.remote.ssh.TmuxGateway
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

sealed interface AppScreen {
    data object Servers : AppScreen
    data class EditServer(val profileId: String?) : AppScreen
    data class Credentials(val profileId: String) : AppScreen
    data object Sessions : AppScreen
    data class Console(val sessionName: String) : AppScreen
}

data class HostKeyPrompt(
    val id: String,
    val message: String
)

data class AppUiState(
    val profiles: List<ServerProfile> = emptyList(),
    val screen: AppScreen = AppScreen.Servers,
    val connectedProfile: ServerProfile? = null,
    val sessions: List<PanePilotSession> = emptyList(),
    val selectedSession: PanePilotSession? = null,
    val transcript: String = "",
    val paneTitle: String = "",
    val composer: String = "",
    val isBusy: Boolean = false,
    val isSending: Boolean = false,
    val hostKeyPrompt: HostKeyPrompt? = null,
    val error: String? = null
)

private data class PendingTrust(
    val id: String,
    val latch: CountDownLatch = CountDownLatch(1),
    @Volatile var accepted: Boolean = false
)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val profileStore = ProfileStore(application)
    private val pendingTrust = AtomicReference<PendingTrust?>(null)
    private val ssh = SshConnection(application, profileStore, ::awaitHostKeyDecision)
    private val tmux = TmuxGateway(ssh)
    private val _state = MutableStateFlow(AppUiState(profiles = profileStore.load()))
    val state: StateFlow<AppUiState> = _state.asStateFlow()

    private var consolePolling: Job? = null
    private var consoleFailureReported = false

    fun addServer() {
        _state.update { it.copy(screen = AppScreen.EditServer(null), error = null) }
    }

    fun editServer(profileId: String) {
        _state.update { it.copy(screen = AppScreen.EditServer(profileId), error = null) }
    }

    fun openCredentials(profileId: String) {
        _state.update { it.copy(screen = AppScreen.Credentials(profileId), error = null) }
    }

    fun saveServer(profile: ServerProfile, selectedKey: Uri?) {
        val normalized = profile.copy(
            name = profile.name.trim(),
            host = profile.host.trim(),
            username = profile.username.trim()
        )
        val validationError = validateProfile(normalized, selectedKey)
        if (validationError != null) {
            showError(validationError)
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(isBusy = true, error = null) }
            runCatching {
                withContext(Dispatchers.IO) {
                    profileStore.save(normalized, selectedKey)
                }
            }.onSuccess { profiles ->
                _state.update {
                    it.copy(
                        profiles = profiles,
                        screen = AppScreen.Servers,
                        isBusy = false
                    )
                }
            }.onFailure(::finishWithError)
        }
    }

    fun deleteServer(profileId: String) {
        viewModelScope.launch {
            val profiles = withContext(Dispatchers.IO) { profileStore.delete(profileId) }
            _state.update {
                it.copy(profiles = profiles, screen = AppScreen.Servers, error = null)
            }
        }
    }

    fun forgetHostKey(profileId: String) {
        val profile = profile(profileId) ?: return
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { ssh.forgetHostKey(profile) }
            }.onSuccess {
                _state.update {
                    it.copy(error = "Saved host key removed. Verify the fingerprint when you reconnect.")
                }
            }.onFailure(::finishWithError)
        }
    }

    fun connect(profileId: String, secret: ConnectionSecret) {
        val profile = profile(profileId) ?: return
        viewModelScope.launch {
            _state.update { it.copy(isBusy = true, error = null) }
            runCatching {
                withContext(Dispatchers.IO) {
                    ssh.connect(profile, secret)
                    tmux.reset()
                    tmux.listSessions()
                }
            }.onSuccess { sessions ->
                _state.update {
                    it.copy(
                        connectedProfile = profile,
                        sessions = sessions,
                        screen = AppScreen.Sessions,
                        isBusy = false,
                        composer = "",
                        transcript = ""
                    )
                }
            }.onFailure { error ->
                ssh.disconnect()
                finishWithError(error)
            }
        }
    }

    fun disconnect() {
        consolePolling?.cancel()
        consolePolling = null
        ssh.disconnect()
        tmux.reset()
        _state.update {
            it.copy(
                connectedProfile = null,
                sessions = emptyList(),
                selectedSession = null,
                transcript = "",
                paneTitle = "",
                composer = "",
                isBusy = false,
                isSending = false,
                screen = AppScreen.Servers
            )
        }
    }

    fun refreshSessions() {
        if (!ssh.isConnected || _state.value.isBusy) return
        viewModelScope.launch {
            _state.update { it.copy(isBusy = true, error = null) }
            runCatching {
                withContext(Dispatchers.IO) { tmux.listSessions() }
            }.onSuccess { sessions ->
                _state.update { it.copy(sessions = sessions, isBusy = false) }
            }.onFailure(::finishWithError)
        }
    }

    fun openConsole(sessionName: String) {
        val selected = _state.value.sessions.firstOrNull { it.name == sessionName } ?: return
        _state.update {
            it.copy(
                selectedSession = selected,
                screen = AppScreen.Console(sessionName),
                transcript = "",
                paneTitle = selected.paneTitle,
                composer = "",
                error = null
            )
        }
        startConsolePolling(sessionName)
    }

    fun updateComposer(value: String) {
        if (value.toByteArray().size <= 32 * 1024) {
            _state.update { it.copy(composer = value) }
        }
    }

    fun sendMessage() {
        val current = _state.value
        val sessionName = current.selectedSession?.name ?: return
        val message = current.composer
        if (message.isBlank() || current.isSending) return
        viewModelScope.launch {
            _state.update { it.copy(isSending = true, error = null) }
            runCatching {
                withContext(Dispatchers.IO) { tmux.send(sessionName, message) }
            }.onSuccess {
                _state.update { it.copy(composer = "", isSending = false) }
                delay(250)
                refreshConsole(sessionName, reportError = true)
            }.onFailure { error ->
                _state.update { it.copy(isSending = false) }
                finishWithError(error)
            }
        }
    }

    fun answerHostKey(promptId: String, accepted: Boolean) {
        val pending = pendingTrust.get() ?: return
        if (pending.id != promptId) return
        pending.accepted = accepted
        pending.latch.countDown()
        _state.update { it.copy(hostKeyPrompt = null) }
    }

    fun clearError() {
        _state.update { it.copy(error = null) }
    }

    fun goBack() {
        when (_state.value.screen) {
            AppScreen.Servers -> Unit
            is AppScreen.EditServer, is AppScreen.Credentials ->
                _state.update { it.copy(screen = AppScreen.Servers, error = null) }

            AppScreen.Sessions -> disconnect()
            is AppScreen.Console -> {
                consolePolling?.cancel()
                consolePolling = null
                _state.update {
                    it.copy(
                        screen = AppScreen.Sessions,
                        selectedSession = null,
                        transcript = "",
                        composer = "",
                        error = null
                    )
                }
                refreshSessions()
            }
        }
    }

    fun profile(profileId: String): ServerProfile? =
        _state.value.profiles.firstOrNull { it.id == profileId }

    fun hasPrivateKey(profileId: String): Boolean = profileStore.hasPrivateKey(profileId)

    override fun onCleared() {
        pendingTrust.getAndSet(null)?.latch?.countDown()
        ssh.disconnect()
        super.onCleared()
    }

    private fun startConsolePolling(sessionName: String) {
        consolePolling?.cancel()
        consoleFailureReported = false
        consolePolling = viewModelScope.launch {
            while (_state.value.screen == AppScreen.Console(sessionName)) {
                refreshConsole(sessionName, reportError = true)
                delay(2_000)
            }
        }
    }

    private suspend fun refreshConsole(sessionName: String, reportError: Boolean) {
        runCatching {
            withContext(Dispatchers.IO) { tmux.capture(sessionName) }
        }.onSuccess { snapshot ->
            consoleFailureReported = false
            _state.update { current ->
                val prior = current.selectedSession
                val updated = prior?.copy(
                    paneTitle = snapshot.paneTitle,
                    paneDead = snapshot.paneDead,
                    state = TmuxGateway.stateFrom(
                        snapshot.paneTitle,
                        prior.profile,
                        snapshot.paneDead
                    )
                )
                current.copy(
                    selectedSession = updated,
                    paneTitle = snapshot.paneTitle,
                    transcript = snapshot.transcript
                )
            }
        }.onFailure { error ->
            if (reportError && !consoleFailureReported) {
                consoleFailureReported = true
                showError(messageFor(error))
            }
        }
    }

    private fun awaitHostKeyDecision(message: String): Boolean {
        val request = PendingTrust(UUID.randomUUID().toString())
        if (!pendingTrust.compareAndSet(null, request)) return false
        _state.update {
            it.copy(
                hostKeyPrompt = HostKeyPrompt(
                    id = request.id,
                    message = message.ifBlank {
                        "This server is not known yet. Verify its SSH fingerprint before trusting it."
                    }
                )
            )
        }
        val answered = request.latch.await(2, TimeUnit.MINUTES)
        pendingTrust.compareAndSet(request, null)
        _state.update { current ->
            if (current.hostKeyPrompt?.id == request.id) current.copy(hostKeyPrompt = null)
            else current
        }
        return answered && request.accepted
    }

    private fun validateProfile(profile: ServerProfile, selectedKey: Uri?): String? {
        if (profile.name.isBlank()) return "Give this server a name."
        if (
            profile.host.isBlank() ||
            profile.host.any { it.isWhitespace() || it.code < 32 || it.code == 127 }
        ) {
            return "Enter a valid SSH host name or IP address."
        }
        if (profile.port !in 1..65_535) return "SSH port must be between 1 and 65535."
        if (
            profile.username.isBlank() ||
            profile.username.any { it.isWhitespace() || it.code < 32 || it.code == 127 }
        ) {
            return "Enter a valid SSH username."
        }
        if (
            profile.authMode == AuthMode.PRIVATE_KEY &&
            selectedKey == null &&
            !profileStore.hasPrivateKey(profile.id)
        ) {
            return "Choose a private key for this server."
        }
        return null
    }

    private fun finishWithError(error: Throwable) {
        _state.update { it.copy(isBusy = false, isSending = false, error = messageFor(error)) }
    }

    private fun showError(message: String) {
        _state.update { it.copy(error = message) }
    }

    private fun messageFor(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: "Something went wrong."
}
