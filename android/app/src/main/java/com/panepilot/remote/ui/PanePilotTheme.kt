package com.panepilot.remote.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Ink = Color(0xFF0C1424)
val Slate = Color(0xFF17233A)
val SlateRaised = Color(0xFF202E48)
val Fog = Color(0xFFF4F7FB)
val Muted = Color(0xFFA9B5CA)
val PilotBlue = Color(0xFF4E7BFF)
val Sky = Color(0xFF8DB4FF)
val Attention = Color(0xFFFFB454)
val Danger = Color(0xFFFF6B7A)
val Success = Color(0xFF66D4A4)

private val PanePilotColors = darkColorScheme(
    primary = PilotBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF203B78),
    onPrimaryContainer = Color(0xFFDCE7FF),
    secondary = Sky,
    onSecondary = Ink,
    background = Ink,
    onBackground = Fog,
    surface = Slate,
    onSurface = Fog,
    surfaceVariant = SlateRaised,
    onSurfaceVariant = Muted,
    error = Danger,
    onError = Ink,
    outline = Color(0xFF3B4B68),
    outlineVariant = Color(0xFF2B3953)
)

@Composable
fun PanePilotTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = PanePilotColors,
        content = content
    )
}
