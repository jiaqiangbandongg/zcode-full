package com.example.zcode_mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = BrandBlueDark,
    secondary = NeutralDarkSubtle,
    background = NeutralDarkBackground,
    surface = NeutralDarkSurface,
    onPrimary = NeutralDarkBackground,
    onSecondary = NeutralDarkBackground,
    onBackground = NeutralDarkText,
    onSurface = NeutralDarkText,
    onSurfaceVariant = NeutralDarkSubtle,
)

private val LightColorScheme = lightColorScheme(
    primary = BrandBlue,
    secondary = NeutralLightSubtle,
    background = NeutralLightBackground,
    surface = NeutralLightSurface,
    onPrimary = NeutralLightSurface,
    onSecondary = NeutralLightSurface,
    onBackground = NeutralLightText,
    onSurface = NeutralLightText,
    onSurfaceVariant = NeutralLightSubtle,
)

@Composable
fun ZcodemobileTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
