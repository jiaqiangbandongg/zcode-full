package com.example.zcode_mobile.ui

import android.annotation.SuppressLint
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.example.zcode_mobile.BuildConfig
import com.example.zcode_mobile.R
import com.example.zcode_mobile.remote.RemoteControlRecentLink
import com.example.zcode_mobile.remote.RemoteControlUrlPolicy
import com.example.zcode_mobile.remote.displaySubtitle
import com.example.zcode_mobile.remote.displayTitle
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@Composable
fun RemoteControlApp(
    remoteUrl: String?,
    recentLinks: List<RemoteControlRecentLink>,
    modifier: Modifier = Modifier,
    onOpenUrl: (String) -> Boolean,
    onCloseRemote: () -> Unit,
    onClearRecentLinks: () -> Unit,
) {
    val context = LocalContext.current
    var scannerOpen by rememberSaveable { mutableStateOf(false) }
    var launcherError by rememberSaveable { mutableStateOf<String?>(null) }
    val cameraPermissionDenied = stringResource(R.string.remote_scan_permission_denied)
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            launcherError = null
            scannerOpen = true
        } else {
            launcherError = cameraPermissionDenied
        }
    }

    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
    ) {
        if (scannerOpen) {
            RemoteControlQrScanner(
                onClose = {
                    scannerOpen = false
                },
                onScanned = { raw ->
                    val opened = onOpenUrl(raw)
                    if (opened) {
                        scannerOpen = false
                        launcherError = null
                    } else {
                        launcherError = context.getString(R.string.remote_scan_invalid)
                    }
                    opened
                },
            )
        } else if (remoteUrl == null) {
            RemoteControlLauncher(
                recentLinks = recentLinks,
                errorMessage = launcherError,
                onOpenUrl = { raw ->
                    val opened = onOpenUrl(raw)
                    if (opened) {
                        launcherError = null
                    }
                    opened
                },
                onScanQrCode = {
                    if (
                        ContextCompat.checkSelfPermission(
                            context,
                            Manifest.permission.CAMERA,
                        ) == PackageManager.PERMISSION_GRANTED
                    ) {
                        launcherError = null
                        scannerOpen = true
                    } else {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                },
                onClearRecentLinks = onClearRecentLinks,
            )
        } else {
            RemoteControlWebViewScreen(
                remoteUrl = remoteUrl,
                onCloseRemote = onCloseRemote,
            )
        }
    }
}

@Composable
private fun RemoteControlQrScanner(
    onClose: () -> Unit,
    onScanned: (String) -> Boolean,
) {
    var scanError by rememberSaveable { mutableStateOf<String?>(null) }

    BackHandler(onBack = onClose)

    Box(modifier = Modifier.fillMaxSize()) {
        RemoteQrCameraPreview(
            onScanned = onScanned,
            onCameraError = {
                scanError = it
            },
        )
        Surface(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .statusBarsPadding(),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.remote_scan_title),
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        text = stringResource(R.string.remote_scan_hint),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onClose) {
                    Text(stringResource(R.string.remote_close_button))
                }
            }
        }
        scanError?.let { message ->
            Surface(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(16.dp),
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f),
                tonalElevation = 2.dp,
            ) {
                Text(
                    text = message,
                    modifier = Modifier.padding(14.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

@Composable
private fun RemoteQrCameraPreview(
    onScanned: (String) -> Boolean,
    onCameraError: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
    }
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }
    val consumed = remember { AtomicBoolean(false) }
    val disposed = remember { AtomicBoolean(false) }
    var cameraProvider by remember { mutableStateOf<ProcessCameraProvider?>(null) }
    val invalidQrMessage = stringResource(R.string.remote_scan_invalid)

    DisposableEffect(Unit) {
        onDispose {
            disposed.set(true)
            cameraProvider?.unbindAll()
            scanner.close()
            cameraExecutor.shutdown()
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { viewContext ->
            PreviewView(viewContext).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                bindRemoteQrCamera(
                    context = context,
                    lifecycleOwner = lifecycleOwner,
                    previewView = this,
                    scanner = scanner,
                    cameraExecutor = cameraExecutor,
                    consumed = consumed,
                    disposed = disposed,
                    onProviderReady = { provider ->
                        cameraProvider = provider
                    },
                    onScanned = { raw ->
                        val accepted = onScanned(raw)
                        if (!accepted) {
                            onCameraError(invalidQrMessage)
                            consumed.set(false)
                        }
                    },
                    onCameraError = onCameraError,
                )
            }
        },
    )
}

private fun bindRemoteQrCamera(
    context: Context,
    lifecycleOwner: LifecycleOwner,
    previewView: PreviewView,
    scanner: BarcodeScanner,
    cameraExecutor: ExecutorService,
    consumed: AtomicBoolean,
    disposed: AtomicBoolean,
    onProviderReady: (ProcessCameraProvider) -> Unit,
    onScanned: (String) -> Unit,
    onCameraError: (String) -> Unit,
) {
    val providerFuture = ProcessCameraProvider.getInstance(context)
    providerFuture.addListener(
        {
            val provider = runCatching { providerFuture.get() }
                .getOrElse { error ->
                    previewView.post {
                        onCameraError(error.message ?: context.getString(R.string.remote_scan_camera_failed))
                    }
                    return@addListener
                }
            if (disposed.get()) {
                provider.unbindAll()
                return@addListener
            }

            onProviderReady(provider)
            val preview = Preview.Builder().build().also {
                it.surfaceProvider = previewView.surfaceProvider
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { imageAnalysis ->
                    imageAnalysis.setAnalyzer(cameraExecutor) { imageProxy ->
                        analyzeRemoteQrImage(
                            scanner = scanner,
                            imageProxy = imageProxy,
                            consumed = consumed,
                            previewView = previewView,
                            onScanned = onScanned,
                        )
                    }
                }

            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis,
                )
            }.onFailure { error ->
                previewView.post {
                    onCameraError(error.message ?: context.getString(R.string.remote_scan_camera_failed))
                }
            }
        },
        ContextCompat.getMainExecutor(context),
    )
}

private fun analyzeRemoteQrImage(
    scanner: BarcodeScanner,
    imageProxy: ImageProxy,
    consumed: AtomicBoolean,
    previewView: PreviewView,
    onScanned: (String) -> Unit,
) {
    if (consumed.get()) {
        imageProxy.close()
        return
    }

    val mediaImage = imageProxy.image
    if (mediaImage == null) {
        imageProxy.close()
        return
    }

    val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
    scanner.process(image)
        .addOnSuccessListener { barcodes ->
            val rawValue = barcodes.firstNotNullOfOrNull { barcode ->
                barcode.rawValue?.takeIf { it.isNotBlank() }
            }
            if (rawValue != null && consumed.compareAndSet(false, true)) {
                previewView.post {
                    onScanned(rawValue)
                }
            }
        }
        .addOnCompleteListener {
            imageProxy.close()
        }
}

@Composable
private fun RemoteControlLauncher(
    recentLinks: List<RemoteControlRecentLink>,
    errorMessage: String?,
    onOpenUrl: (String) -> Boolean,
    onScanQrCode: () -> Unit,
    onClearRecentLinks: () -> Unit,
) {
    val context = LocalContext.current
    var input by rememberSaveable { mutableStateOf("") }
    var localError by rememberSaveable { mutableStateOf<String?>(null) }
    val invalidUrlMessage = stringResource(R.string.remote_url_invalid)
    val visibleError = localError ?: errorMessage

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(R.string.remote_launcher_title),
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.remote_launcher_description),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(20.dp))
        OutlinedTextField(
            value = input,
            onValueChange = {
                input = it
                localError = null
            },
            modifier = Modifier.fillMaxWidth(),
            singleLine = false,
            minLines = 2,
            label = { Text(stringResource(R.string.remote_url_label)) },
            placeholder = { Text(stringResource(R.string.remote_url_placeholder)) },
            isError = visibleError != null,
            supportingText = {
                visibleError?.let {
                    Text(it)
                }
            },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        Spacer(modifier = Modifier.height(12.dp))
        Button(
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                if (!onOpenUrl(input)) {
                    localError = invalidUrlMessage
                }
            },
        ) {
            Text(stringResource(R.string.remote_open_button))
        }
        Spacer(modifier = Modifier.height(8.dp))
        OutlinedButton(
            modifier = Modifier.fillMaxWidth(),
            onClick = onScanQrCode,
        ) {
            Text(stringResource(R.string.remote_scan_button))
        }
        if (recentLinks.isNotEmpty()) {
            Spacer(modifier = Modifier.height(20.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.remote_recent_title),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onBackground,
                )
                TextButton(onClick = onClearRecentLinks) {
                    Text(stringResource(R.string.remote_recent_clear))
                }
            }
            recentLinks.forEach { link ->
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        // Bugfix: 二维码链接很长，用户重启 App 后手输容易出错。
                        // 这里复用本地已校验过的历史记录，但打开前仍走 onOpenUrl 的白名单校验。
                        if (!onOpenUrl(link.url)) {
                            localError = invalidUrlMessage
                        }
                    },
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.Start,
                    ) {
                        Text(
                            text = link.displayTitle(),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            text = link.displaySubtitle(context),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RemoteControlWebViewScreen(
    remoteUrl: String,
    onCloseRemote: () -> Unit,
) {
    val context = LocalContext.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    var progress by remember { mutableStateOf(0) }
    var isLoading by remember { mutableStateOf(true) }
    var pageError by remember { mutableStateOf<String?>(null) }

    BackHandler {
        val view = webView
        if (view != null && view.canGoBack()) {
            view.goBack()
        } else {
            onCloseRemote()
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            webView?.destroy()
            webView = null
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        RemoteControlTopBar(
            remoteUrl = remoteUrl,
            isLoading = isLoading,
            onReload = {
                pageError = null
                webView?.reload()
            },
            onClose = onCloseRemote,
        )
        if (isLoading) {
            LinearProgressIndicator(
                progress = { (progress.coerceIn(0, 100) / 100f) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Box(modifier = Modifier.fillMaxSize()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = {
                    createRemoteControlWebView(
                        context = context,
                        onLoadingChanged = { loading ->
                            isLoading = loading
                        },
                        onProgressChanged = { nextProgress ->
                            progress = nextProgress
                        },
                        onMainFrameError = { message ->
                            pageError = message
                        },
                    ).also { view ->
                        webView = view
                        view.loadUrl(remoteUrl)
                    }
                },
                update = { view ->
                    if (view.url != remoteUrl) {
                        pageError = null
                        view.loadUrl(remoteUrl)
                    }
                },
            )
            if (pageError != null) {
                RemoteControlErrorOverlay(
                    message = pageError.orEmpty(),
                    onRetry = {
                        pageError = null
                        webView?.reload()
                    },
                )
            }
        }
    }
}

@Composable
private fun RemoteControlTopBar(
    remoteUrl: String,
    isLoading: Boolean,
    onReload: () -> Unit,
    onClose: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .height(48.dp)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.remote_screen_title),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                text = remoteUrl,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
            )
            Spacer(modifier = Modifier.width(8.dp))
        }
        TextButton(onClick = onReload) {
            Text(stringResource(R.string.remote_reload_button))
        }
        TextButton(onClick = onClose) {
            Text(stringResource(R.string.remote_close_button))
        }
    }
}

@Composable
private fun RemoteControlErrorOverlay(
    message: String,
    onRetry: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.Start,
        ) {
            Text(
                text = stringResource(R.string.remote_load_failed_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(16.dp))
            Button(onClick = onRetry) {
                Text(stringResource(R.string.remote_retry_button))
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createRemoteControlWebView(
    context: android.content.Context,
    onLoadingChanged: (Boolean) -> Unit,
    onProgressChanged: (Int) -> Unit,
    onMainFrameError: (String) -> Unit,
): WebView {
    CookieManager.getInstance().setAcceptCookie(true)

    return WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        overScrollMode = WebView.OVER_SCROLL_NEVER
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString ZCodeAndroid/${BuildConfig.VERSION_NAME}"
        }
        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                onProgressChanged(newProgress)
            }
        }
        webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                onLoadingChanged(true)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                onLoadingChanged(false)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                if (!request.isForMainFrame) {
                    return false
                }

                val resolved = RemoteControlUrlPolicy.resolve(request.url)
                if (resolved != null) {
                    if (request.url.scheme == "zcode") {
                        view.loadUrl(resolved)
                        return true
                    }
                    return false
                }

                openExternalUrl(view.context, request.url)
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                if (request?.isForMainFrame != true) {
                    return
                }
                onLoadingChanged(false)
                onMainFrameError(error?.description?.toString().orEmpty())
            }
        }
    }
}

private fun openExternalUrl(context: android.content.Context, uri: Uri) {
    val intent = Intent(Intent.ACTION_VIEW, uri)
    runCatching {
        context.startActivity(intent)
    }
}
