package com.panepilot.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.panepilot.remote.ui.CredentialsScreen
import com.panepilot.remote.ui.HostKeyDialog
import com.panepilot.remote.ui.PanePilotTheme
import com.panepilot.remote.ui.ServerEditorScreen
import com.panepilot.remote.ui.ServerListScreen
import com.panepilot.remote.ui.SessionConsoleScreen
import com.panepilot.remote.ui.SessionListScreen
import com.panepilot.remote.ui.Ink

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(0x00000000),
            navigationBarStyle = SystemBarStyle.dark(0x00000000)
        )
        setContent {
            PanePilotTheme {
                val appViewModel: AppViewModel = viewModel()
                val state by appViewModel.state.collectAsStateWithLifecycle()
                val snackbar = remember { SnackbarHostState() }

                LaunchedEffect(state.error) {
                    state.error?.let {
                        snackbar.showSnackbar(it)
                        appViewModel.clearError()
                    }
                }

                BackHandler(enabled = state.screen != AppScreen.Servers) {
                    appViewModel.goBack()
                }

                Scaffold(
                    containerColor = Ink,
                    snackbarHost = { SnackbarHost(snackbar) },
                    contentWindowInsets = WindowInsets(0, 0, 0, 0)
                ) { innerPadding ->
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(innerPadding)
                    ) {
                        when (val screen = state.screen) {
                            AppScreen.Servers -> ServerListScreen(
                                profiles = state.profiles,
                                onAdd = appViewModel::addServer,
                                onEdit = appViewModel::editServer,
                                onConnect = appViewModel::openCredentials
                            )

                            is AppScreen.EditServer -> ServerEditorScreen(
                                profile = screen.profileId?.let(appViewModel::profile),
                                hasStoredKey = screen.profileId?.let(appViewModel::hasPrivateKey) == true,
                                isBusy = state.isBusy,
                                onBack = appViewModel::goBack,
                                onSave = appViewModel::saveServer,
                                onDelete = screen.profileId?.let { id ->
                                    { appViewModel.deleteServer(id) }
                                },
                                onForgetHostKey = screen.profileId?.let { id ->
                                    { appViewModel.forgetHostKey(id) }
                                }
                            )

                            is AppScreen.Credentials -> {
                                appViewModel.profile(screen.profileId)?.let { profile ->
                                    CredentialsScreen(
                                        profile = profile,
                                        isBusy = state.isBusy,
                                        onBack = appViewModel::goBack,
                                        onConnect = { appViewModel.connect(profile.id, it) }
                                    )
                                }
                            }

                            AppScreen.Sessions -> SessionListScreen(
                                profile = state.connectedProfile,
                                sessions = state.sessions,
                                isRefreshing = state.isBusy,
                                onRefresh = appViewModel::refreshSessions,
                                onDisconnect = appViewModel::disconnect,
                                onOpenSession = appViewModel::openConsole
                            )

                            is AppScreen.Console -> SessionConsoleScreen(
                                session = state.selectedSession,
                                transcript = state.transcript,
                                paneTitle = state.paneTitle,
                                composer = state.composer,
                                isSending = state.isSending,
                                onBack = appViewModel::goBack,
                                onComposerChange = appViewModel::updateComposer,
                                onSend = appViewModel::sendMessage
                            )
                        }
                    }
                }

                state.hostKeyPrompt?.let { prompt ->
                    HostKeyDialog(
                        prompt = prompt,
                        onAnswer = { appViewModel.answerHostKey(prompt.id, it) }
                    )
                }
            }
        }
    }
}
