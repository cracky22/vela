package de.cracky.vela.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.ui.unit.IntOffset
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.DonutLarge
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.ui.graphics.vector.ImageVector
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
    var tab by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf("chats") }
    val convs by repo.convs.collectAsState()
    val statuses by repo.statuses.collectAsState()

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
                    BackHandler(enabled = active != null || tab != "chats") {
                        if (active != null) repo.closeChat() else tab = "chats"
                    }
                    val dest = if (active != null) "chat:$active" else "tab:$tab"
                    val unreadChats = convs.filter { it.status == "accepted" && !it.archived && !it.muted }.sumOf { it.unread }
                    val unseenStatus = statuses.filter { !it.seen && it.userId != repo.myId }.map { it.userId }.toSet().size
                    Column(Modifier.fillMaxSize()) {
                        Box(Modifier.weight(1f).fillMaxWidth()) {
                            AnimatedContent(
                                targetState = dest,
                                transitionSpec = {
                                    fun rank(d: String) = if (d.startsWith("chat:")) 10 else listOf("tab:chats", "tab:status", "tab:settings").indexOf(d)
                                    val forward = rank(targetState) > rank(initialState)
                                    val spec = spring<IntOffset>(dampingRatio = 0.9f, stiffness = 420f)
                                    if (forward) {
                                        (slideInHorizontally(spec) { it / 3 } + fadeIn(tween(220))) togetherWith
                                            (slideOutHorizontally(spec) { -it / 6 } + fadeOut(tween(160)))
                                    } else {
                                        (slideInHorizontally(spec) { -it / 6 } + fadeIn(tween(220))) togetherWith
                                            (slideOutHorizontally(spec) { it / 3 } + fadeOut(tween(160)))
                                    }
                                },
                                label = "navigation",
                            ) { d ->
                                when {
                                    d.startsWith("chat:") -> ChatScreen(repo, d.removePrefix("chat:")) { repo.closeChat() }
                                    d == "tab:status" -> StatusScreen(repo)
                                    d == "tab:settings" -> SettingsScreen(repo) { tab = "chats" }
                                    else -> ChatListScreen(repo, onSettings = { tab = "settings" })
                                }
                            }
                        }
                        AnimatedVisibility(
                            visible = active == null,
                            enter = expandVertically(spring(stiffness = 500f)) + fadeIn(),
                            exit = shrinkVertically(spring(stiffness = 500f)) + fadeOut(),
                        ) {
                            val haptics = rememberHaptics()
                            NavigationBar {
                                NavItem(tab == "chats", "Chats", Icons.Filled.Chat, unreadChats) { if (tab != "chats") haptics.tick(); tab = "chats" }
                                NavItem(tab == "status", "Status", Icons.Filled.DonutLarge, unseenStatus) { if (tab != "status") haptics.tick(); tab = "status" }
                                NavItem(tab == "settings", "Einstellungen", Icons.Filled.Settings, 0) { if (tab != "settings") haptics.tick(); tab = "settings" }
                            }
                        }
                    }
                }
            }
            SnackbarHost(snack, Modifier.align(Alignment.BottomCenter))
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.NavItem(selected: Boolean, label: String, icon: ImageVector, badge: Int, onClick: () -> Unit) {
    NavigationBarItem(
        selected = selected, onClick = onClick, label = { Text(label) },
        icon = {
            BadgedBox(badge = { if (badge > 0) Badge { Text(if (badge > 99) "99+" else badge.toString()) } }) { Icon(icon, label) }
        },
    )
}

@Composable
private fun BannerBar(repo: Repo) {
    val b by repo.banner.collectAsState()
    val last = remember { arrayOf(b) }
    if (b.kind != Banner.Kind.None) last[0] = b
    val shown = last[0]
    val (bg, fg) = when (shown.kind) {
        Banner.Kind.Maintenance -> Color(0xFFFFE9A8) to Color(0xFF2A2000)
        Banner.Kind.Offline -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        else -> Color(0xFFD1ECA0) to Color(0xFF121F00)
    }
    AnimatedVisibility(
        visible = b.kind != Banner.Kind.None,
        enter = expandVertically(spring(stiffness = 500f)) + fadeIn(),
        exit = shrinkVertically(spring(stiffness = 500f)) + fadeOut(),
    ) {
        Row(Modifier.fillMaxWidth().background(bg).padding(horizontal = 16.dp, vertical = 6.dp)) {
            Text(shown.text, color = fg, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center, style = MaterialTheme.typography.labelLarge)
        }
    }
}
