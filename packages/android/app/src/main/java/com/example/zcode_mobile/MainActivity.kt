package com.example.zcode_mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.example.zcode_mobile.remote.RemoteControlKeepAliveService
import com.example.zcode_mobile.remote.RemoteControlRecentLink
import com.example.zcode_mobile.remote.RemoteControlRecentLinksStore
import com.example.zcode_mobile.remote.RemoteControlUrlPolicy
import com.example.zcode_mobile.ui.RemoteControlApp
import com.example.zcode_mobile.ui.theme.ZcodemobileTheme

class MainActivity : ComponentActivity() {
    private var remoteUrl by mutableStateOf<String?>(null)
    private var recentLinks by mutableStateOf<List<RemoteControlRecentLink>>(emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (BuildConfig.DEBUG) {
            android.webkit.WebView.setWebContentsDebuggingEnabled(true)
        }
        recentLinks = RemoteControlRecentLinksStore.read(this)

        val restoredRemoteUrl = savedInstanceState?.getString(KEY_REMOTE_URL)
        val launchRemoteUrl = restoredRemoteUrl ?: resolveRemoteUrlFromIntent(intent)
        launchRemoteUrl?.let { openRemoteUrl(it) }

        setContent {
            ZcodemobileTheme {
                RemoteControlApp(
                    remoteUrl = remoteUrl,
                    recentLinks = recentLinks,
                    onOpenUrl = ::openRemoteUrl,
                    onCloseRemote = ::closeRemote,
                    onClearRecentLinks = ::clearRecentLinks,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        resolveRemoteUrlFromIntent(intent)?.let { openRemoteUrl(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        remoteUrl?.let { outState.putString(KEY_REMOTE_URL, it) }
    }

    private fun openRemoteUrl(rawUrl: String): Boolean {
        val resolvedUrl = RemoteControlUrlPolicy.resolve(rawUrl) ?: return false
        recentLinks = RemoteControlRecentLinksStore.record(this, resolvedUrl)
        remoteUrl = resolvedUrl
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestNotificationPermissionIfNeeded()
        RemoteControlKeepAliveService.start(this, resolvedUrl)
        return true
    }

    private fun closeRemote() {
        remoteUrl = null
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        RemoteControlKeepAliveService.stop(this)
    }

    private fun clearRecentLinks() {
        recentLinks = RemoteControlRecentLinksStore.clear(this)
    }

    private fun resolveRemoteUrlFromIntent(intent: Intent?): String? {
        if (intent == null) {
            return null
        }

        intent.getStringExtra(RemoteControlKeepAliveService.EXTRA_REMOTE_URL)?.let { raw ->
            RemoteControlUrlPolicy.resolve(raw)?.let { return it }
        }
        intent.data?.let { uri ->
            RemoteControlUrlPolicy.resolve(uri)?.let { return it }
        }
        intent.getStringExtra(Intent.EXTRA_TEXT)?.let { raw ->
            RemoteControlUrlPolicy.resolve(raw)?.let { return it }
        }

        return null
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return
        }
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }

    companion object {
        private const val KEY_REMOTE_URL = "remoteUrl"
        private const val REQUEST_NOTIFICATIONS = 4001
    }
}
