package de.cracky.vela

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import de.cracky.vela.service.Notifier
import de.cracky.vela.ui.AppRoot
import de.cracky.vela.ui.VelaTheme
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    private val pendingConv = MutableStateFlow<String?>(null)
    private val repo get() = (application as VelaApp).repo

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingConv.value = intent?.getStringExtra(Notifier.EXTRA_CONV)
        if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        setContent { VelaTheme { AppRoot(repo, pendingConv) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(Notifier.EXTRA_CONV)?.let { pendingConv.value = it }
    }

    override fun onStart() { super.onStart(); repo.onForeground() }
    override fun onStop() { super.onStop(); repo.onBackground() }
}
