package de.cracky.vela.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Farben aus static/css/theme.css (Orange des App-Icons)
private val Light = lightColorScheme(
    primary = Color(0xFFA46300), onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDCBB), onPrimaryContainer = Color(0xFF2C1700),
    secondary = Color(0xFF7A5832), onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFDCBB), onSecondaryContainer = Color(0xFF2C1700),
    tertiary = Color(0xFF4F6629), tertiaryContainer = Color(0xFFD1ECA0), onTertiaryContainer = Color(0xFF121F00),
    error = Color(0xFFBA1A1A), errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF410002),
    background = Color(0xFFFFF8F4), surface = Color(0xFFFFF8F4), onSurface = Color(0xFF221A12),
    surfaceVariant = Color(0xFFF6E5D8), onSurfaceVariant = Color(0xFF56432F),
    outline = Color(0xFF8A735C), outlineVariant = Color(0xFFDDC2A8),
    surfaceContainer = Color(0xFFFBEBDE), surfaceContainerHigh = Color(0xFFF6E5D8),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFFFB869), onPrimary = Color(0xFF482900),
    primaryContainer = Color(0xFF673D00), onPrimaryContainer = Color(0xFFFFDCBB),
    secondary = Color(0xFFEBBE90), onSecondary = Color(0xFF462A08),
    secondaryContainer = Color(0xFF5F401D), onSecondaryContainer = Color(0xFFFFDCBB),
    tertiary = Color(0xFFB5D087), tertiaryContainer = Color(0xFF384D13), onTertiaryContainer = Color(0xFFD1ECA0),
    error = Color(0xFFFFB4AB), errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF19120A), surface = Color(0xFF19120A), onSurface = Color(0xFFEDE0D4),
    surfaceVariant = Color(0xFF52443A), onSurfaceVariant = Color(0xFFD7C3B3),
    outline = Color(0xFF9F8D7E), outlineVariant = Color(0xFF52443A),
    surfaceContainer = Color(0xFF261E16), surfaceContainerHigh = Color(0xFF30281F),
)

// Ausdrucksstärkere Formen (großzügige Rundungen) und kräftigere Schriftschnitte im Stil von Material 3 Expressive
private val VelaShapes = Shapes(
    extraSmall = RoundedCornerShape(10.dp),
    small = RoundedCornerShape(16.dp),
    medium = RoundedCornerShape(24.dp),
    large = RoundedCornerShape(32.dp),
    extraLarge = RoundedCornerShape(40.dp),
)

private val base = Typography()
private val VelaType = Typography(
    displaySmall = base.displaySmall.copy(fontWeight = FontWeight.Bold),
    headlineLarge = base.headlineLarge.copy(fontWeight = FontWeight.Bold),
    headlineMedium = base.headlineMedium.copy(fontWeight = FontWeight.Bold),
    headlineSmall = base.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
    titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold),
    titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
    labelLarge = base.labelLarge.copy(fontWeight = FontWeight.SemiBold),
)

@Composable
fun VelaTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, shapes = VelaShapes, typography = VelaType, content = content)
}
