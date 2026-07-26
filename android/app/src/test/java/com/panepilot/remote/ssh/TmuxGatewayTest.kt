package com.panepilot.remote.ssh

import com.panepilot.remote.model.SessionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class TmuxGatewayTest {
    @Test
    fun `parses only versioned PanePilot sessions`() {
        val separator = TmuxGateway.FIELD_SEPARATOR
        val path = Base64.getUrlEncoder().withoutPadding()
            .encodeToString("/srv/panepilot".toByteArray())
        val fields = listOf(
            "codex-main",
            "1",
            "Thinking · 2/4 tasks",
            "codex",
            "0",
            "1",
            "1",
            "2c4f2d29-2985-4f48-a846-85ff0638984c",
            "b50a1e21-fbb4-4103-b287-7586411e6716",
            path,
            "codex",
            "2026-07-25T00:00:00.000Z",
            "0",
            "terminal",
            "",
            ""
        )

        val sessions = TmuxGateway.parseSessionList(fields.joinToString(separator.toString()))

        assertEquals(1, sessions.size)
        assertEquals("/srv/panepilot", sessions.single().projectPath)
        assertEquals(SessionState.RUNNING, sessions.single().state)
    }

    @Test
    fun `maps PanePilot title snapshots without treating shells as agents`() {
        assertEquals(
            SessionState.NEEDS_INPUT,
            TmuxGateway.stateFrom("Action required · approve command", "codex", false)
        )
        assertEquals(
            SessionState.READY,
            TmuxGateway.stateFrom("Ready · 4/4 tasks", "codex", false)
        )
        assertEquals(SessionState.LIVE, TmuxGateway.stateFrom("project", "shell", false))
        assertEquals(SessionState.STOPPED, TmuxGateway.stateFrom("Ready", "codex", true))
    }

    @Test
    fun `shell quoting contains special text in one argument`() {
        val quoted = TmuxGateway.shellQuote("name'; touch /tmp/nope; echo '")

        assertTrue(quoted.startsWith("'"))
        assertTrue(quoted.endsWith("'"))
        assertTrue(quoted.contains("'\\''"))
        assertFalse(quoted.contains("\n"))
    }
}
