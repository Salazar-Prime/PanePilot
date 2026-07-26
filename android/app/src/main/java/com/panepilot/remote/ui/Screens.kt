package com.panepilot.remote.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.panepilot.remote.HostKeyPrompt
import com.panepilot.remote.model.AuthMode
import com.panepilot.remote.model.ConnectionSecret
import com.panepilot.remote.model.PanePilotSession
import com.panepilot.remote.model.ServerProfile
import com.panepilot.remote.model.SessionState
import kotlinx.coroutines.delay
import java.util.UUID

@Composable
fun ServerListScreen(
    profiles: List<ServerProfile>,
    onAdd: () -> Unit,
    onEdit: (String) -> Unit,
    onConnect: (String) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        ScreenHeader(
            eyebrow = "PANE / REMOTE",
            title = "Your servers",
            action = {
                FilledIconButton(onClick = onAdd) {
                    Icon(Icons.Default.Add, contentDescription = "Add server")
                }
            }
        )
        if (profiles.isEmpty()) {
            EmptyServers(onAdd)
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 20.dp,
                    end = 20.dp,
                    top = 8.dp,
                    bottom = 24.dp
                ),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                item {
                    Text(
                        "Choose a server to inspect its live PanePilot sessions.",
                        color = Muted,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
                }
                items(profiles, key = { it.id }) { profile ->
                    ServerCard(
                        profile = profile,
                        onEdit = { onEdit(profile.id) },
                        onConnect = { onConnect(profile.id) }
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyServers(onAdd: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(28.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Surface(
                shape = RoundedCornerShape(22.dp),
                color = Slate,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
            ) {
                Text(
                    ">_",
                    color = Sky,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 22.dp, vertical = 18.dp)
                )
            }
            Spacer(Modifier.height(24.dp))
            Text(
                "Add your first SSH server",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "PanePilot Remote connects directly. It does not need a relay or remote daemon.",
                color = Muted,
                style = MaterialTheme.typography.bodyMedium
            )
            Spacer(Modifier.height(22.dp))
            Button(onClick = onAdd) {
                Icon(Icons.Default.Add, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Add server")
            }
        }
    }
}

@Composable
private fun ServerCard(
    profile: ServerProfile,
    onEdit: () -> Unit,
    onConnect: () -> Unit
) {
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = Slate,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onConnect)
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(SlateRaised),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    profile.name.take(1).uppercase(),
                    color = Sky,
                    fontWeight = FontWeight.Bold
                )
            }
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    profile.name,
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.titleMedium
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    "${profile.username}@${profile.host}:${profile.port}",
                    color = Muted,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            IconButton(onClick = onEdit) {
                Icon(Icons.Default.Edit, contentDescription = "Edit ${profile.name}", tint = Muted)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerEditorScreen(
    profile: ServerProfile?,
    hasStoredKey: Boolean,
    isBusy: Boolean,
    onBack: () -> Unit,
    onSave: (ServerProfile, Uri?) -> Unit,
    onDelete: (() -> Unit)?,
    onForgetHostKey: (() -> Unit)?
) {
    val draftId = remember(profile?.id) { profile?.id ?: UUID.randomUUID().toString() }
    var name by rememberSaveable(profile?.id) { mutableStateOf(profile?.name.orEmpty()) }
    var host by rememberSaveable(profile?.id) { mutableStateOf(profile?.host.orEmpty()) }
    var port by rememberSaveable(profile?.id) {
        mutableStateOf(profile?.port?.toString() ?: "22")
    }
    var username by rememberSaveable(profile?.id) {
        mutableStateOf(profile?.username.orEmpty())
    }
    var authMode by rememberSaveable(profile?.id) {
        mutableStateOf(profile?.authMode ?: AuthMode.PRIVATE_KEY)
    }
    var selectedKey by remember { mutableStateOf<Uri?>(null) }
    var selectedKeyName by rememberSaveable(profile?.id) {
        mutableStateOf(profile?.keyDisplayName.orEmpty())
    }
    var deleteConfirm by remember { mutableStateOf(false) }
    var forgetConfirm by remember { mutableStateOf(false) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val keyPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            selectedKey = uri
            selectedKeyName = context.displayName(uri) ?: "Selected private key"
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        BackHeader(
            title = if (profile == null) "Add server" else "Edit server",
            onBack = onBack
        )
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Name") },
                placeholder = { Text("Build server") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text("Host or IP address") },
                placeholder = { Text("server.example.com") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it },
                    label = { Text("Username") },
                    singleLine = true,
                    modifier = Modifier.weight(1f)
                )
                OutlinedTextField(
                    value = port,
                    onValueChange = { port = it.filter(Char::isDigit).take(5) },
                    label = { Text("Port") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    singleLine = true,
                    modifier = Modifier.width(104.dp)
                )
            }
            Text(
                "Authentication",
                color = Muted,
                style = MaterialTheme.typography.labelLarge
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FilterChip(
                    selected = authMode == AuthMode.PRIVATE_KEY,
                    onClick = { authMode = AuthMode.PRIVATE_KEY },
                    label = { Text("Private key") }
                )
                FilterChip(
                    selected = authMode == AuthMode.PASSWORD,
                    onClick = { authMode = AuthMode.PASSWORD },
                    label = { Text("Password") }
                )
            }
            AnimatedVisibility(authMode == AuthMode.PRIVATE_KEY) {
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = Slate,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(
                            when {
                                selectedKeyName.isNotBlank() -> selectedKeyName
                                hasStoredKey -> "Private key stored"
                                else -> "No private key selected"
                            },
                            fontWeight = FontWeight.Medium
                        )
                        Spacer(Modifier.height(5.dp))
                        Text(
                            "The key is copied into this app's private storage. Passphrases are never saved.",
                            color = Muted,
                            style = MaterialTheme.typography.bodySmall
                        )
                        Spacer(Modifier.height(12.dp))
                        OutlinedButton(onClick = { keyPicker.launch(arrayOf("*/*")) }) {
                            Text(if (hasStoredKey || selectedKey != null) "Replace key" else "Choose key")
                        }
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Button(
                onClick = {
                    onSave(
                        ServerProfile(
                            id = draftId,
                            name = name,
                            host = host,
                            port = port.toIntOrNull() ?: 0,
                            username = username,
                            authMode = authMode,
                            keyDisplayName = selectedKeyName.takeIf { it.isNotBlank() }
                        ),
                        selectedKey
                    )
                },
                enabled = !isBusy,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
            ) {
                if (isBusy) {
                    CircularProgressIndicator(
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(20.dp),
                        color = Color.White
                    )
                } else {
                    Text("Save server")
                }
            }
            if (profile != null) {
                HorizontalDivider(
                    modifier = Modifier.padding(vertical = 8.dp),
                    color = MaterialTheme.colorScheme.outlineVariant
                )
                Text(
                    "SSH identity",
                    color = Muted,
                    style = MaterialTheme.typography.labelLarge
                )
                Text(
                    "If your server is rebuilt and its verified fingerprint changes, remove the saved host key before reconnecting.",
                    color = Muted,
                    style = MaterialTheme.typography.bodySmall
                )
                TextButton(onClick = { forgetConfirm = true }) {
                    Text("Forget saved host key")
                }
                TextButton(
                    onClick = { deleteConfirm = true },
                    colors = ButtonDefaults.textButtonColors(contentColor = Danger)
                ) {
                    Icon(Icons.Default.Delete, contentDescription = null)
                    Spacer(Modifier.width(7.dp))
                    Text("Delete server")
                }
            }
            Spacer(Modifier.height(20.dp))
        }
    }

    if (deleteConfirm && onDelete != null) {
        ConfirmDialog(
            title = "Delete ${profile?.name}?",
            body = "This removes the server profile and its imported private key from this phone. It does not change the server.",
            confirmLabel = "Delete",
            destructive = true,
            onDismiss = { deleteConfirm = false },
            onConfirm = onDelete
        )
    }
    if (forgetConfirm && onForgetHostKey != null) {
        ConfirmDialog(
            title = "Forget saved host key?",
            body = "Verify the SSH fingerprint carefully the next time you connect.",
            confirmLabel = "Forget key",
            destructive = true,
            onDismiss = { forgetConfirm = false },
            onConfirm = {
                forgetConfirm = false
                onForgetHostKey()
            }
        )
    }
}

@Composable
fun CredentialsScreen(
    profile: ServerProfile,
    isBusy: Boolean,
    onBack: () -> Unit,
    onConnect: (ConnectionSecret) -> Unit
) {
    var password by remember(profile.id) { mutableStateOf("") }
    var passphrase by remember(profile.id) { mutableStateOf("") }
    val isPassword = profile.authMode == AuthMode.PASSWORD

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        BackHeader(title = "Connect", onBack = onBack)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp)
        ) {
            Text(
                profile.name,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold
            )
            Spacer(Modifier.height(5.dp))
            Text(
                "${profile.username}@${profile.host}:${profile.port}",
                color = Muted,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp
            )
            Spacer(Modifier.height(28.dp))
            OutlinedTextField(
                value = if (isPassword) password else passphrase,
                onValueChange = { if (isPassword) password = it else passphrase = it },
                label = {
                    Text(if (isPassword) "SSH password" else "Private key passphrase (optional)")
                },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(10.dp))
            Text(
                if (isPassword) {
                    "The password is kept in memory only for this connection."
                } else {
                    "Leave this blank if the private key has no passphrase."
                },
                color = Muted,
                style = MaterialTheme.typography.bodySmall
            )
            Spacer(Modifier.height(24.dp))
            Button(
                onClick = {
                    onConnect(ConnectionSecret(password = password, keyPassphrase = passphrase))
                },
                enabled = !isBusy && (!isPassword || password.isNotEmpty()),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
            ) {
                if (isBusy) {
                    CircularProgressIndicator(
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(20.dp),
                        color = Color.White
                    )
                    Spacer(Modifier.width(10.dp))
                    Text("Connecting…")
                } else {
                    Text("Connect over SSH")
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionListScreen(
    profile: ServerProfile?,
    sessions: List<PanePilotSession>,
    isRefreshing: Boolean,
    onRefresh: () -> Unit,
    onDisconnect: () -> Unit,
    onOpenSession: (String) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        ScreenHeader(
            eyebrow = "SSH / ${profile?.name?.uppercase().orEmpty()}",
            title = "Live sessions",
            action = {
                IconButton(onClick = onRefresh, enabled = !isRefreshing) {
                    if (isRefreshing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            strokeWidth = 2.dp
                        )
                    } else {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh sessions")
                    }
                }
            },
            navigation = {
                IconButton(onClick = onDisconnect) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Disconnect")
                }
            }
        )
        if (sessions.isEmpty() && !isRefreshing) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(28.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "No live PanePilot sessions",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Start a tmux-backed session from PanePilot desktop, then refresh.",
                        color = Muted,
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }
        } else {
            val projects = sessions.groupBy { it.projectPath }
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 20.dp,
                    end = 20.dp,
                    bottom = 28.dp
                ),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                projects.forEach { (path, projectSessions) ->
                    stickyHeader(key = path) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(Ink)
                                .padding(top = 14.dp, bottom = 8.dp)
                        ) {
                            Text(
                                projectSessions.first().projectName,
                                fontWeight = FontWeight.SemiBold,
                                style = MaterialTheme.typography.titleMedium
                            )
                            Text(
                                path,
                                color = Muted,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }
                    items(projectSessions, key = { it.terminalId }) { session ->
                        SessionCard(session = session, onClick = { onOpenSession(session.name) })
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionCard(session: PanePilotSession, onClick: () -> Unit) {
    val stateColor = stateColor(session.state)
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = Slate,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !session.paneDead, onClick = onClick)
    ) {
        Row(modifier = Modifier.height(IntrinsicSize.Min)) {
            Box(
                modifier = Modifier
                    .width(5.dp)
                    .fillMaxHeight()
                    .background(stateColor)
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 15.dp, vertical = 13.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        session.name,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        stateLabel(session.state),
                        color = stateColor,
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold
                    )
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    session.typeLabel,
                    color = Muted,
                    style = MaterialTheme.typography.bodySmall
                )
                if (session.paneTitle.isNotBlank()) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        session.paneTitle,
                        color = Sky,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                if (session.dangerousMode) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "UNSAFE PERMISSIONS",
                        color = Danger,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 0.8.sp
                    )
                }
            }
        }
    }
}

@Composable
fun SessionConsoleScreen(
    session: PanePilotSession?,
    transcript: String,
    paneTitle: String,
    composer: String,
    isSending: Boolean,
    onBack: () -> Unit,
    onComposerChange: (String) -> Unit,
    onSend: () -> Unit
) {
    val verticalScroll = rememberScrollState()
    val horizontalScroll = rememberScrollState()
    LaunchedEffect(transcript) {
        delay(60)
        verticalScroll.scrollTo(verticalScroll.maxValue)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .imePadding()
    ) {
        BackHeader(
            title = session?.name ?: "Session",
            onBack = onBack,
            subtitle = paneTitle.takeIf { it.isNotBlank() }
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Slate)
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(session?.state?.let(::stateColor) ?: Muted)
            )
            Spacer(Modifier.width(8.dp))
            Text(
                session?.typeLabel.orEmpty(),
                color = Muted,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.weight(1f)
            )
            Text(
                session?.state?.let(::stateLabel).orEmpty(),
                color = session?.state?.let(::stateColor) ?: Muted,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold
            )
        }
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(Color(0xFF080E19))
        ) {
            if (transcript.isBlank()) {
                Text(
                    "Reading tmux pane…",
                    color = Muted,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(16.dp)
                )
            } else {
                androidx.compose.foundation.text.selection.SelectionContainer {
                    Text(
                        transcript,
                        color = Color(0xFFDCE5F5),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.5.sp,
                        lineHeight = 17.sp,
                        modifier = Modifier
                            .fillMaxHeight()
                            .horizontalScroll(horizontalScroll)
                            .verticalScroll(verticalScroll)
                            .padding(14.dp)
                    )
                }
            }
        }
        Surface(
            color = Slate,
            tonalElevation = 4.dp,
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
        ) {
            Row(
                modifier = Modifier.padding(12.dp),
                verticalAlignment = Alignment.Bottom
            ) {
                OutlinedTextField(
                    value = composer,
                    onValueChange = onComposerChange,
                    enabled = session?.paneDead != true,
                    placeholder = {
                        Text(
                            if (session?.profile in listOf("codex", "claude")) {
                                "Message the agent"
                            } else {
                                "Send terminal input"
                            }
                        )
                    },
                    minLines = 1,
                    maxLines = 4,
                    modifier = Modifier.weight(1f)
                )
                Spacer(Modifier.width(10.dp))
                FilledIconButton(
                    onClick = onSend,
                    enabled = composer.isNotBlank() && !isSending && session?.paneDead != true,
                    modifier = Modifier.size(52.dp)
                ) {
                    if (isSending) {
                        CircularProgressIndicator(
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(20.dp),
                            color = Color.White
                        )
                    } else {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                    }
                }
            }
        }
    }
}

@Composable
fun HostKeyDialog(prompt: HostKeyPrompt, onAnswer: (Boolean) -> Unit) {
    AlertDialog(
        onDismissRequest = { onAnswer(false) },
        title = { Text("Verify SSH host") },
        text = {
            Column {
                Text(
                    "Compare this fingerprint with the one shown by your server provider or administrator.",
                    color = Muted,
                    style = MaterialTheme.typography.bodyMedium
                )
                Spacer(Modifier.height(14.dp))
                Surface(
                    color = Color(0xFF080E19),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    androidx.compose.foundation.text.selection.SelectionContainer {
                        Text(
                            prompt.message,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            lineHeight = 16.sp,
                            modifier = Modifier.padding(12.dp)
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onAnswer(true) }) {
                Text("Trust and connect")
            }
        },
        dismissButton = {
            TextButton(onClick = { onAnswer(false) }) {
                Text("Cancel")
            }
        }
    )
}

@Composable
private fun ScreenHeader(
    eyebrow: String,
    title: String,
    action: @Composable () -> Unit,
    navigation: (@Composable () -> Unit)? = null
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        navigation?.invoke()
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = if (navigation == null) 8.dp else 2.dp)
        ) {
            Text(
                eyebrow,
                color = Sky,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.4.sp
            )
            Text(
                title,
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold
            )
        }
        action()
    }
}

@Composable
private fun BackHeader(
    title: String,
    onBack: () -> Unit,
    subtitle: String? = null
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            subtitle?.let {
                Text(
                    it,
                    color = Sky,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
private fun ConfirmDialog(
    title: String,
    body: String,
    confirmLabel: String,
    destructive: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body, color = Muted) },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                colors = ButtonDefaults.textButtonColors(
                    contentColor = if (destructive) Danger else PilotBlue
                )
            ) {
                Text(confirmLabel)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

private fun stateColor(state: SessionState): Color = when (state) {
    SessionState.NEEDS_INPUT -> Attention
    SessionState.RUNNING -> PilotBlue
    SessionState.READY -> Sky
    SessionState.IDLE -> Muted
    SessionState.LIVE -> Success
    SessionState.STOPPED -> Danger
}

private fun stateLabel(state: SessionState): String = when (state) {
    SessionState.NEEDS_INPUT -> "NEEDS INPUT"
    SessionState.RUNNING -> "WORKING"
    SessionState.READY -> "READY"
    SessionState.IDLE -> "IDLE"
    SessionState.LIVE -> "LIVE"
    SessionState.STOPPED -> "STOPPED"
}

private fun Context.displayName(uri: Uri): String? {
    return contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
}
