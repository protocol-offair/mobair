package com.airpay.wallet.airpaynative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import com.airpay.wallet.MainActivity
import com.airpay.wallet.R

class AirPayBackgroundService : Service() {
  private var connectivityManager: ConnectivityManager? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var windowManager: WindowManager? = null
  private var overlayView: View? = null
  private var overlayParams: WindowManager.LayoutParams? = null

  override fun onCreate() {
    super.onCreate()
    isRunning = true
    registerNetworkCallback()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        hideOverlay()
        stopForeground(STOP_FOREGROUND_REMOVE_COMPAT)
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_SHOW_OVERLAY -> showOverlay()
      ACTION_HIDE_OVERLAY -> hideOverlay()
      else -> startRuntimeForeground()
    }

    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    hideOverlay()
    unregisterNetworkCallback()
    isRunning = false
    super.onDestroy()
  }

  private fun startRuntimeForeground() {
    createNotificationChannel()
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(): Notification {
    val launchIntent = Intent(this, MainActivity::class.java)
    val flags =
      PendingIntent.FLAG_UPDATE_CURRENT or
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
    val pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, flags)
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, CHANNEL_ID)
      } else {
        Notification.Builder(this)
      }

    return builder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(getString(R.string.airpay_background_notification_title))
      .setContentText(getString(R.string.airpay_background_notification_body))
      .setContentIntent(pendingIntent)
      .setOngoing(true)
      .setShowWhen(false)
      .build()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = getSystemService(NotificationManager::class.java)
    val channel =
      NotificationChannel(
        CHANNEL_ID,
        getString(R.string.airpay_background_channel_name),
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = getString(R.string.airpay_background_notification_body)
        setShowBadge(false)
      }
    manager.createNotificationChannel(channel)
  }

  private fun registerNetworkCallback() {
    val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    connectivityManager = manager
    val callback =
      object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          emitNetworkStatus(isNetworkConnected())
        }

        override fun onLost(network: Network) {
          emitNetworkStatus(isNetworkConnected())
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
          emitNetworkStatus(hasUsableInternet(networkCapabilities))
        }
      }
    networkCallback = callback
    val request =
      NetworkRequest.Builder()
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .build()
    manager.registerNetworkCallback(request, callback)
    emitNetworkStatus(isNetworkConnected())
  }

  private fun unregisterNetworkCallback() {
    val manager = connectivityManager
    val callback = networkCallback
    if (manager != null && callback != null) {
      try {
        manager.unregisterNetworkCallback(callback)
      } catch (_: Throwable) {
        // The callback may already be unregistered during service teardown.
      }
    }
    networkCallback = null
    connectivityManager = null
  }

  private fun isNetworkConnected(): Boolean {
    val manager = connectivityManager ?: getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
    val network = manager.activeNetwork ?: return false
    val capabilities = manager.getNetworkCapabilities(network) ?: return false
    return hasUsableInternet(capabilities)
  }

  private fun hasUsableInternet(capabilities: NetworkCapabilities): Boolean =
    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
      capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

  private fun emitNetworkStatus(connected: Boolean) {
    sendBroadcast(
      Intent(ACTION_NETWORK_STATUS).apply {
        setPackage(packageName)
        putExtra(EXTRA_CONNECTED, connected)
        putExtra(EXTRA_OCCURRED_AT, System.currentTimeMillis())
      },
    )
  }

  private fun showOverlay() {
    if (!Settings.canDrawOverlays(this) || overlayView != null) {
      return
    }

    val manager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val type =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      } else {
        @Suppress("DEPRECATION")
        WindowManager.LayoutParams.TYPE_PHONE
      }
    val params =
      WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        type,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
      ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = 24
        y = 160
      }

    val overlay = createOverlayView(params)
    windowManager = manager
    overlayParams = params
    overlayView = overlay
    manager.addView(overlay, params)
    overlayVisible = true
  }

  private fun createOverlayView(params: WindowManager.LayoutParams): View {
    val container =
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(28, 18, 28, 18)
        setBackgroundColor(Color.argb(232, 8, 19, 29))
      }
    val title =
      TextView(this).apply {
        text = getString(R.string.airpay_overlay_title)
        textSize = 14f
        setTextColor(Color.WHITE)
        includeFontPadding = false
      }
    val body =
      TextView(this).apply {
        text = getString(R.string.airpay_overlay_body)
        textSize = 12f
        setTextColor(Color.rgb(184, 243, 90))
        includeFontPadding = false
      }
    container.addView(title)
    container.addView(body)
    container.setOnTouchListener(DragTouchListener(params))
    return container
  }

  private fun hideOverlay() {
    val manager = windowManager
    val view = overlayView
    if (manager != null && view != null) {
      try {
        manager.removeView(view)
      } catch (_: Throwable) {
        // Ignore stale overlay handles.
      }
    }
    overlayView = null
    overlayParams = null
    overlayVisible = false
  }

  private inner class DragTouchListener(private val params: WindowManager.LayoutParams) : View.OnTouchListener {
    private var startX = 0
    private var startY = 0
    private var touchStartX = 0f
    private var touchStartY = 0f

    override fun onTouch(view: View, event: MotionEvent): Boolean {
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          startX = params.x
          startY = params.y
          touchStartX = event.rawX
          touchStartY = event.rawY
          return true
        }
        MotionEvent.ACTION_MOVE -> {
          params.x = startX + (event.rawX - touchStartX).toInt()
          params.y = startY + (event.rawY - touchStartY).toInt()
          windowManager?.updateViewLayout(view, params)
          return true
        }
      }
      return false
    }
  }

  companion object {
    const val ACTION_START = "com.airpay.wallet.airpaynative.START_BACKGROUND_RUNTIME"
    const val ACTION_STOP = "com.airpay.wallet.airpaynative.STOP_BACKGROUND_RUNTIME"
    const val ACTION_SHOW_OVERLAY = "com.airpay.wallet.airpaynative.SHOW_OVERLAY"
    const val ACTION_HIDE_OVERLAY = "com.airpay.wallet.airpaynative.HIDE_OVERLAY"
    const val ACTION_NETWORK_STATUS = "com.airpay.wallet.airpaynative.NETWORK_STATUS"
    const val EXTRA_CONNECTED = "connected"
    const val EXTRA_OCCURRED_AT = "occurredAt"

    private const val CHANNEL_ID = "airpay_background_runtime"
    private const val NOTIFICATION_ID = 9041
    private const val STOP_FOREGROUND_REMOVE_COMPAT = 1

    @Volatile
    var isRunning: Boolean = false
      private set

    @Volatile
    var overlayVisible: Boolean = false
      private set
  }
}
