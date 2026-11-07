package de.cracky.vela.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import de.cracky.vela.data.Banner
import de.cracky.vela.data.Phase
import de.cracky.vela.data.Repo
import kotlinx.coroutines.flow.MutableStateFlow

@Composable
fun AppRoot(repo: Repo, pendingConv: MutableStateFlow<String?>) {
    val phase by repo.phase.collectAsState()
    val active by repo.activeChat.collectAsState()
    val pending by pendingConv.collectAsState()
    val toast by repo.toast.collectAsState()
    val snack = remember { SnackbarHostState() }
    var screen by remember { mutableStateOf<Screen>(Screen.List) }

    LaunchedEffect(toast) {
        toast?.let { snack.showSnackbar(it); repo.toast.value = null }
    }
    LaunchedEffect(pending, phase) {
        val id = pending
        if (id != null && phase == Phase.Ready) {
            repo.openChat(id)
            pendingConv.value = null
        }
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).safeDrawingPadding()) {
        BannerBar(repo)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (phase) {
                Phase.Boot -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                Phase.LoggedOut -> AuthHost(repo)
                Phase.Totp -> TotpFlow(repo)
                Phase.NeedKeys -> UnlockScreen(repo)
                Phase.Ready -> {
                    BackHandler(enabled = active != null || screen != Screen.List) {
                        if (screen != Screen.List) screen = Screen.List else repo.closeChat()
                    }
                    when {
                        screen == Screen.Settings -> SettingsScreen(repo) { screen = Screen.List }
                        active != null -> ChatScreen(repo, active!!) { repo.closeChat() }
                        else -> ChatListScreen(repo, onSettings = { screen = Screen.Settings })
                    }
                }
            }
            SnackbarHost(snack, Modifier.align(Alignment.BottomCenter))
        }
    }
}

enum class Screen { List, Settings }

@Composable
private fun BannerBar(repo: Repo) {
    val b by repo.banner.collectAsState()
    if (b.kind == Banner.Kind.None) return
    val (bg, fg) = when (b.kind) {
        Banner.Kind.Maintenance -> Color(0xFFFFE9A8) to Color(0xFF2A2000)
        Banner.Kind.Offline -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        else -> Color(0xFFD1ECA0) to Color(0xFF121F00)
    }
    Row(Modifier.fillMaxWidth().background(bg).padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text(b.text, color = fg, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center, style = MaterialTheme.typography.labelLarge)
    }
}
