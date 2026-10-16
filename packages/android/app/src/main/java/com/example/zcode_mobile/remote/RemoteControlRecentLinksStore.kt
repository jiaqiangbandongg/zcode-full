package com.example.zcode_mobile.remote

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

data class RemoteControlRecentLink(
    val url: String,
    val openedAt: Long,
)

object RemoteControlRecentLinksStore {
    private const val PREFS_NAME = "zcode_remote_control_recent_links"
    private const val KEY_LINKS = "links_v1"
    private const val MAX_LINKS = 5

    fun read(context: Context): List<RemoteControlRecentLink> {
        val raw = prefs(context).getString(KEY_LINKS, null) ?: return emptyList()
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val url = item.optString("url").takeIf { it.isNotBlank() } ?: continue
                val openedAt = item.optLong("openedAt", 0L).takeIf { it > 0L } ?: continue
                if (RemoteControlUrlPolicy.resolve(url) != null) {
                    add(RemoteControlRecentLink(url = url, openedAt = openedAt))
                }
            }
        }.take(MAX_LINKS)
    }

    fun record(context: Context, url: String): List<RemoteControlRecentLink> {
        val resolvedUrl = RemoteControlUrlPolicy.resolve(url) ?: return read(context)
        val updated = listOf(RemoteControlRecentLink(resolvedUrl, System.currentTimeMillis()))
            .plus(read(context).filterNot { it.url == resolvedUrl })
            .take(MAX_LINKS)
        write(context, updated)
        return updated
    }

    fun clear(context: Context): List<RemoteControlRecentLink> {
        prefs(context).edit().remove(KEY_LINKS).apply()
        return emptyList()
    }

    private fun write(context: Context, links: List<RemoteControlRecentLink>) {
        val array = JSONArray()
        links.forEach { link ->
            array.put(
                JSONObject()
                    .put("url", link.url)
                    .put("openedAt", link.openedAt),
            )
        }
        prefs(context).edit().putString(KEY_LINKS, array.toString()).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}

fun RemoteControlRecentLink.displayTitle(): String {
    val uri = Uri.parse(url)
    val name = uri.getQueryParameter("name")?.takeIf { it.isNotBlank() }
    return name ?: uri.host.orEmpty().ifBlank { "ZCode Remote" }
}

fun RemoteControlRecentLink.displaySubtitle(context: Context): String {
    val uri = Uri.parse(url)
    val time = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
        .format(Date(openedAt))
    return "${uri.host.orEmpty()} · $time"
}
