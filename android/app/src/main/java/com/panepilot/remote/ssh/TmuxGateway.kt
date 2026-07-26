package com.panepilot.remote.ssh

import com.panepilot.remote.model.PanePilotSession
import com.panepilot.remote.model.SessionState
import java.util.Base64
import java.util.UUID

class TmuxGateway(private val ssh: SshConnection) {
    private var tmuxPath: String? = null

    fun reset() {
        tmuxPath = null
    }

    fun listSessions(): List<PanePilotSession> {
        val tmux = resolveTmux()
        val format = listOf(
            "#{session_name}",
            "#{session_attached}",
            "#{pane_title}",
            "#{pane_current_command}",
            "#{pane_dead}",
            "#{@panepilot_managed}",
            "#{@panepilot_schema}",
            "#{@panepilot_terminal_id}",
            "#{@panepilot_project_id}",
            "#{@panepilot_project_path}",
            "#{@panepilot_profile}",
            "#{@panepilot_created_at}",
            "#{@panepilot_dangerous_mode}",
            "#{@panepilot_session_kind}",
            "#{@panepilot_action_name}",
            "#{@panepilot_latex_section_title}"
        ).joinToString(FIELD_SEPARATOR.toString())
        val result = ssh.execute(
            "${shellQuote(tmux)} list-sessions -F ${shellQuote(format)}",
            maxOutputBytes = 512 * 1024
        )
        if (
            result.exitCode != 0 &&
            !result.stderr.contains("no server running", ignoreCase = true) &&
            !result.stderr.contains("failed to connect to server", ignoreCase = true)
        ) {
            throw IllegalStateException(result.stderr.trim().ifBlank {
                "Tmux sessions could not be listed."
            })
        }
        return parseSessionList(result.stdout)
    }

    fun capture(sessionName: String): PaneSnapshot {
        val tmux = resolveTmux()
        val target = "=$sessionName:"
        val command =
            "${shellQuote(tmux)} display-message -p -t ${shellQuote(target)} " +
                "${shellQuote("#{pane_title}$FIELD_SEPARATOR#{pane_dead}")} && " +
                "${shellQuote(tmux)} capture-pane -p -J -S -300 -t ${shellQuote(target)}"
        val result = ssh.execute(command, maxOutputBytes = 768 * 1024)
        if (result.exitCode != 0) {
            throw IllegalStateException(result.stderr.trim().ifBlank {
                "The tmux pane could not be read."
            })
        }
        val newline = result.stdout.indexOf('\n')
        val metadataLine = if (newline >= 0) result.stdout.substring(0, newline) else ""
        val transcript = if (newline >= 0) result.stdout.substring(newline + 1) else result.stdout
        val metadata = metadataLine.trimEnd('\r').split(FIELD_SEPARATOR, limit = 2)
        return PaneSnapshot(
            paneTitle = metadata.getOrElse(0) { "" },
            paneDead = metadata.getOrElse(1) { "0" } == "1",
            transcript = transcript.trimEnd()
        )
    }

    fun send(sessionName: String, message: String) {
        require(message.isNotBlank()) { "Type a message first." }
        require(!message.contains('\u0000')) { "Messages cannot contain a null character." }
        val payload = message.toByteArray()
        require(payload.size <= MAX_MESSAGE_BYTES) { "Messages must be 32 KB or smaller." }

        val tmux = resolveTmux()
        val target = "=$sessionName:"
        val bufferName = "panepilot-mobile-${UUID.randomUUID()}"
        val command =
            "${shellQuote(tmux)} load-buffer -b ${shellQuote(bufferName)} - && " +
                "${shellQuote(tmux)} paste-buffer -d -b ${shellQuote(bufferName)} " +
                "-t ${shellQuote(target)} && " +
                "${shellQuote(tmux)} send-keys -t ${shellQuote(target)} Enter"
        val result = ssh.execute(command, stdin = payload, maxOutputBytes = 64 * 1024)
        if (result.exitCode != 0) {
            throw IllegalStateException(result.stderr.trim().ifBlank {
                "Tmux could not send the message."
            })
        }
    }

    private fun resolveTmux(): String {
        tmuxPath?.let { return it }
        val result = ssh.execute(RESOLVE_TMUX_COMMAND, maxOutputBytes = 16 * 1024)
        val path = result.stdout.trim().lineSequence().lastOrNull()?.trim().orEmpty()
        if (
            result.exitCode != 0 ||
            !path.startsWith("/") ||
            path.length > 4_096 ||
            path.any { it.code in 0..31 || it.code == 127 }
        ) {
            throw IllegalStateException("Tmux is not installed or is not available to this SSH user.")
        }
        return path.also { tmuxPath = it }
    }

    companion object {
        const val FIELD_SEPARATOR = '\u001f'
        private const val MAX_MESSAGE_BYTES = 32 * 1024
        private val UUID_PATTERN =
            Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
        private val ACTION_REQUIRED =
            Regex("\\b(action required|approval required|permission required|needs input|waiting for (approval|input)|confirm to continue)\\b", RegexOption.IGNORE_CASE)
        private val RUNNING = Regex("\\b(working|thinking)\\b", RegexOption.IGNORE_CASE)
        private val READY = Regex("\\bready\\b", RegexOption.IGNORE_CASE)

        private const val RESOLVE_TMUX_COMMAND =
            "panepilot_tmux=\$(command -v tmux 2>/dev/null || true); " +
                "if [ -z \"\$panepilot_tmux\" ]; then " +
                "for panepilot_candidate in /opt/homebrew/bin/tmux /usr/local/bin/tmux " +
                "/usr/bin/tmux /home/linuxbrew/.linuxbrew/bin/tmux \"\$HOME/.linuxbrew/bin/tmux\"; do " +
                "if [ -x \"\$panepilot_candidate\" ]; then " +
                "panepilot_tmux=\"\$panepilot_candidate\"; break; fi; done; fi; " +
                "if [ -z \"\$panepilot_tmux\" ]; then " +
                "panepilot_tmux=\$(\"\${SHELL:-/bin/sh}\" -lic 'command -v tmux' " +
                "2>/dev/null | tail -n 1); fi; " +
                "case \"\$panepilot_tmux\" in /*) test -x \"\$panepilot_tmux\" || exit 127 ;; " +
                "*) exit 127 ;; esac; printf '%s\\n' \"\$panepilot_tmux\""

        fun shellQuote(value: String): String = "'${value.replace("'", "'\\''")}'"

        fun parseSessionList(output: String): List<PanePilotSession> {
            return output.lineSequence()
                .filter { it.isNotBlank() }
                .take(1_000)
                .mapNotNull(::parseSession)
                .sortedWith(
                    compareBy<PanePilotSession>({ statePriority(it.state) }, { it.projectPath }, { it.name })
                )
                .toList()
        }

        fun stateFrom(title: String, profile: String, paneDead: Boolean): SessionState {
            if (paneDead) return SessionState.STOPPED
            if (ACTION_REQUIRED.containsMatchIn(title)) return SessionState.NEEDS_INPUT
            if (RUNNING.containsMatchIn(title)) return SessionState.RUNNING
            if (READY.containsMatchIn(title)) return SessionState.READY
            return if (profile == "codex" || profile == "claude") {
                SessionState.IDLE
            } else {
                SessionState.LIVE
            }
        }

        private fun parseSession(line: String): PanePilotSession? {
            val fields = line.split(FIELD_SEPARATOR)
            if (fields.size != 16 || fields[5] != "1" || fields[6] != "1") return null
            val name = fields[0]
            val attached = fields[1].toIntOrNull() ?: return null
            val title = fields[2]
            val paneDead = fields[4] == "1"
            val terminalId = fields[7]
            val projectId = fields[8]
            if (
                name.isBlank() ||
                name.length > 80 ||
                name.any { it == ':' || it.code in 0..31 || it.code == 127 } ||
                attached < 0 ||
                !UUID_PATTERN.matches(terminalId) ||
                !UUID_PATTERN.matches(projectId)
            ) {
                return null
            }
            val path = decodeMetadata(fields[9], 4_096) ?: return null
            val profile = fields[10]
            if (profile !in setOf("shell", "codex", "claude", "custom")) return null

            return PanePilotSession(
                name = name,
                attachedClients = attached,
                paneTitle = title,
                currentCommand = fields[3],
                paneDead = paneDead,
                terminalId = terminalId,
                projectId = projectId,
                projectPath = path,
                profile = profile,
                createdAt = fields[11],
                dangerousMode = fields[12] == "1",
                sessionKind = fields[13].ifBlank { "terminal" },
                actionName = decodeMetadata(fields[14], 80),
                latexSectionTitle = decodeMetadata(fields[15], 1_024),
                state = stateFrom(title, profile, paneDead)
            )
        }

        private fun decodeMetadata(value: String, maxLength: Int): String? {
            if (value.isBlank()) return null
            return runCatching {
                String(Base64.getUrlDecoder().decode(value), Charsets.UTF_8)
                    .takeIf { it.isNotBlank() && it.length <= maxLength && !it.contains('\u0000') }
            }.getOrNull()
        }

        private fun statePriority(state: SessionState): Int = when (state) {
            SessionState.NEEDS_INPUT -> 0
            SessionState.RUNNING -> 1
            SessionState.READY -> 2
            SessionState.IDLE -> 3
            SessionState.LIVE -> 4
            SessionState.STOPPED -> 5
        }
    }
}

data class PaneSnapshot(
    val paneTitle: String,
    val paneDead: Boolean,
    val transcript: String
)
