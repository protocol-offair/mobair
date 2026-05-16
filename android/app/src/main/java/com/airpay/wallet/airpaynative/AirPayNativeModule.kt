package com.airpay.wallet.airpaynative

import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import android.nfc.NfcAdapter
import com.airpay.wallet.BuildConfig
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID

class AirPayNativeModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {
  private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private val backgroundEventReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != AirPayBackgroundService.ACTION_NETWORK_STATUS) {
          return
        }
        val connected = intent.getBooleanExtra(AirPayBackgroundService.EXTRA_CONNECTED, false)
        val occurredAt = intent.getLongExtra(AirPayBackgroundService.EXTRA_OCCURRED_AT, System.currentTimeMillis())
        emitEvent(
          "AirPayNetworkAvailable",
          Arguments.createMap().apply {
            putBoolean("connected", connected)
            putDouble("occurredAt", occurredAt.toDouble())
          },
        )
        emitBackgroundRuntimeStatus()
      }
    }
  private val peripheralManager = AirPayBlePeripheralManager(reactContext) { eventName, payload ->
    emitEvent(eventName, payload)
  }

  init {
    registerBackgroundEventReceiver()
  }

  override fun getName(): String = MODULE_NAME

  override fun getConstants(): MutableMap<String, Any> =
    hashMapOf("adbAutomationEnabled" to BuildConfig.AIRPAY_ADB_AUTOMATION)

  @ReactMethod
  fun getAdbAutomationEnabled(promise: Promise) {
    promise.resolve(BuildConfig.AIRPAY_ADB_AUTOMATION)
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by NativeEventEmitter.
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // Required by NativeEventEmitter.
  }

  @ReactMethod
  fun getSupportedCapabilities(promise: Promise) {
    promise.resolve(
      Arguments.createMap().apply {
        putBoolean("nfc", reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC))
        putBoolean("bleCentral", supportsBleCentral())
        putBoolean("blePeripheral", supportsBlePeripheral())
        putBoolean("attestation", true)
        putBoolean("hce", reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION))
        putString("platform", "android")
      },
    )
  }

  @ReactMethod
  fun getBackgroundRuntimeStatus(promise: Promise) {
    promise.resolve(buildBackgroundRuntimeStatus())
  }

  @ReactMethod
  fun startBackgroundRuntime(promise: Promise) {
    try {
      val intent = Intent(reactContext, AirPayBackgroundService::class.java).apply {
        action = AirPayBackgroundService.ACTION_START
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }
      promise.resolve(buildBackgroundRuntimeStatus())
    } catch (error: Throwable) {
      promise.reject("AIRPAY_BACKGROUND_START_ERROR", error)
    }
  }

  @ReactMethod
  fun stopBackgroundRuntime(promise: Promise) {
    try {
      reactContext.startService(
        Intent(reactContext, AirPayBackgroundService::class.java).apply {
          action = AirPayBackgroundService.ACTION_STOP
        },
      )
      promise.resolve(buildBackgroundRuntimeStatus())
    } catch (error: Throwable) {
      promise.reject("AIRPAY_BACKGROUND_STOP_ERROR", error)
    }
  }

  @ReactMethod
  fun showOverlay(promise: Promise) {
    try {
      if (!Settings.canDrawOverlays(reactContext)) {
        promise.resolve(buildBackgroundRuntimeStatus())
        return
      }
      reactContext.startService(
        Intent(reactContext, AirPayBackgroundService::class.java).apply {
          action = AirPayBackgroundService.ACTION_SHOW_OVERLAY
        },
      )
      promise.resolve(buildBackgroundRuntimeStatus())
    } catch (error: Throwable) {
      promise.reject("AIRPAY_OVERLAY_SHOW_ERROR", error)
    }
  }

  @ReactMethod
  fun hideOverlay(promise: Promise) {
    try {
      reactContext.startService(
        Intent(reactContext, AirPayBackgroundService::class.java).apply {
          action = AirPayBackgroundService.ACTION_HIDE_OVERLAY
        },
      )
      promise.resolve(buildBackgroundRuntimeStatus())
    } catch (error: Throwable) {
      promise.reject("AIRPAY_OVERLAY_HIDE_ERROR", error)
    }
  }

  @ReactMethod
  fun requestOverlayPermission(promise: Promise) {
    try {
      if (!Settings.canDrawOverlays(reactContext)) {
        openSystemActivity(
          Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:${reactContext.packageName}"),
          ),
        )
      }
      promise.resolve(buildBackgroundRuntimeStatus())
    } catch (error: Throwable) {
      promise.reject("AIRPAY_OVERLAY_PERMISSION_ERROR", error)
    }
  }

  @ReactMethod
  fun requestBluetoothEnable(promise: Promise) {
    try {
      val adapter = bluetoothAdapter()
      if (adapter == null || adapter.isEnabled) {
        promise.resolve(buildBackgroundRuntimeStatus())
        return
      }
      openSystemActivity(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
      promise.resolve(buildBackgroundRuntimeStatus())
    } catch (error: Throwable) {
      promise.reject("AIRPAY_BLUETOOTH_ENABLE_ERROR", error)
    }
  }

  @ReactMethod
  fun openBluetoothSettings(promise: Promise) {
    try {
      openSystemActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
      promise.resolve(buildBackgroundRuntimeStatus())
    } catch (error: Throwable) {
      promise.reject("AIRPAY_BLUETOOTH_SETTINGS_ERROR", error)
    }
  }

  @ReactMethod
  fun openNfcSettings(promise: Promise) {
    try {
      openSystemActivity(Intent(Settings.ACTION_NFC_SETTINGS))
      promise.resolve(buildBackgroundRuntimeStatus())
    } catch (error: Throwable) {
      promise.reject("AIRPAY_NFC_SETTINGS_ERROR", error)
    }
  }

  @ReactMethod
  fun getIntegrityManifest(config: ReadableMap, promise: Promise) {
    try {
      val appVersion = config.getString("appVersion").orEmpty()
      val policyHash = config.getString("policyHash").orEmpty()
      val challenge = config.getString("attestationChallenge").orEmpty()
      val bleServiceId = config.getString("bleServiceId").orEmpty()
      val keyEntry = ensureKeyMaterial(challenge)
      val keyInfo = getKeyInfo()
      val publicKey = keyEntry.certificate.publicKey.encoded
      val publicKeyBase64 = Base64.encodeToString(publicKey, Base64.NO_WRAP)
      val certificates =
        keyStore.getCertificateChain(KEY_ALIAS)?.map {
          Base64.encodeToString(it.encoded, Base64.NO_WRAP)
        }.orEmpty()
      val deviceId =
        sha256(publicKeyBase64).take(24)
      val keySecurityLevel = resolveSecurityLevel(keyInfo)
      val attestationValid = certificates.size > 1

      promise.resolve(
        Arguments.createMap().apply {
          putString("deviceId", deviceId)
          putString("integrityLevel", keySecurityLevel)
          putBoolean("attestationValid", attestationValid)
          putString("keyAlias", KEY_ALIAS)
          putString("publicKey", publicKeyBase64)
          putString("keySecurityLevel", keySecurityLevel)
          putString("deviceSecurityLevel", keySecurityLevel)
          putBoolean("isHardwareBacked", keySecurityLevel == "tee" || keySecurityLevel == "strongbox")
          putString("attestationChallenge", challenge)
          putArray(
            "attestationCertificates",
            Arguments.createArray().apply {
              certificates.forEach { pushString(it) }
            },
          )
          putMap(
            "transportCapabilities",
            Arguments.createMap().apply {
              putBoolean("nfc", reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC))
              putBoolean("bleCentral", supportsBleCentral())
              putBoolean("blePeripheral", supportsBlePeripheral())
              putBoolean("attestation", attestationValid)
              putBoolean("hce", reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION))
            },
          )
          putString("appVersion", appVersion)
          putString("policyHash", policyHash)
          putString("bleServiceId", bleServiceId)
        },
      )
    } catch (error: Throwable) {
      promise.reject("AIRPAY_INTEGRITY_ERROR", error)
    }
  }

  @ReactMethod
  fun signPayload(payload: String, promise: Promise) {
    try {
      val entry = ensureKeyMaterial(payload.take(64))
      val signature = Signature.getInstance("SHA256withECDSA")
      signature.initSign(entry.privateKey)
      signature.update(payload.toByteArray(Charsets.UTF_8))
      promise.resolve(Base64.encodeToString(signature.sign(), Base64.NO_WRAP))
    } catch (error: Throwable) {
      promise.reject("AIRPAY_SIGN_ERROR", error)
    }
  }

  @ReactMethod
  fun prepareReceiverSession(config: ReadableMap, promise: Promise) {
    try {
      val sessionId = config.getString("sessionId") ?: throw IllegalArgumentException("sessionId is required.")
      val bootstrapPayload =
        config.getString("bootstrapPayload") ?: throw IllegalArgumentException("bootstrapPayload is required.")
      val transportMap = config.getMap("transportIds") ?: throw IllegalArgumentException("transportIds are required.")
      val transportIds = AirPayTransportIds(
        serviceUuid = UUID.fromString(transportMap.getString("serviceUuid")),
        handshakeCharacteristicUuid = UUID.fromString(transportMap.getString("handshakeCharacteristicUuid")),
        transferCharacteristicUuid = UUID.fromString(transportMap.getString("transferCharacteristicUuid")),
        receiptCharacteristicUuid = UUID.fromString(transportMap.getString("receiptCharacteristicUuid")),
        closeCharacteristicUuid = UUID.fromString(transportMap.getString("closeCharacteristicUuid")),
      )

      AirPayHceState.bootstrapPayload = bootstrapPayload
      peripheralManager.start(
        AirPayReceiverConfig(
          sessionId = sessionId,
          bootstrapPayload = bootstrapPayload,
          transportIds = transportIds,
        ),
      )

      promise.resolve(
        Arguments.createMap().apply {
          putString("sessionId", sessionId)
          putBoolean("advertising", true)
          putBoolean("hceReady", true)
          putArray(
            "diagnostics",
            Arguments.createArray().apply {
              pushString("Android Keystore device key is provisioned.")
              pushString("HCE NDEF bootstrap payload updated.")
              pushString("BLE peripheral advertising started.")
            },
          )
        },
      )
    } catch (error: Throwable) {
      promise.reject("AIRPAY_RECEIVER_ERROR", error)
    }
  }

  @ReactMethod
  fun publishReceipt(sessionId: String, receiptPayload: String, promise: Promise) {
    try {
      peripheralManager.publishReceipt(sessionId, receiptPayload)
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("AIRPAY_RECEIPT_ERROR", error)
    }
  }

  @ReactMethod
  fun stopReceiverSession(promise: Promise) {
    try {
      peripheralManager.stop()
      AirPayHceState.bootstrapPayload = "{\"status\":\"idle\"}"
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("AIRPAY_RECEIVER_STOP_ERROR", error)
    }
  }

  override fun invalidate() {
    peripheralManager.stop()
    unregisterBackgroundEventReceiver()
    super.invalidate()
  }

  private fun registerBackgroundEventReceiver() {
    val filter = IntentFilter(AirPayBackgroundService.ACTION_NETWORK_STATUS)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      reactContext.registerReceiver(backgroundEventReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION")
      reactContext.registerReceiver(backgroundEventReceiver, filter)
    }
  }

  private fun unregisterBackgroundEventReceiver() {
    try {
      reactContext.unregisterReceiver(backgroundEventReceiver)
    } catch (_: Throwable) {
      // Ignore if React Native already unregistered the receiver during teardown.
    }
  }

  private fun emitEvent(eventName: String, payload: Any?) {
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(eventName, payload)
  }

  private fun emitBackgroundRuntimeStatus() {
    emitEvent("AirPayBackgroundRuntimeStatus", buildBackgroundRuntimeStatus())
  }

  private fun buildBackgroundRuntimeStatus() =
    Arguments.createMap().apply {
      putBoolean("supported", true)
      putBoolean("backgroundServiceRunning", AirPayBackgroundService.isRunning)
      putBoolean("overlayPermissionGranted", Settings.canDrawOverlays(reactContext))
      putBoolean("overlayVisible", AirPayBackgroundService.overlayVisible)
      putBoolean("bluetoothEnabled", bluetoothAdapter()?.isEnabled == true)
      putBoolean("nfcEnabled", nfcAdapter()?.isEnabled == true)
      putBoolean("networkConnected", isNetworkConnected())
  }

  private fun isNetworkConnected(): Boolean {
    val manager = reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
    val network = manager.activeNetwork ?: return false
    val capabilities = manager.getNetworkCapabilities(network) ?: return false
    return hasUsableInternet(capabilities)
  }

  private fun hasUsableInternet(capabilities: NetworkCapabilities): Boolean =
    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
      capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

  private fun openSystemActivity(intent: Intent) {
    val activity = reactContext.currentActivity
    if (activity != null) {
      activity.startActivity(intent)
      return
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    reactContext.startActivity(intent)
  }

  private fun ensureKeyMaterial(attestationChallenge: String) =
    if (keyStore.containsAlias(KEY_ALIAS)) {
      keyStore.getEntry(KEY_ALIAS, null) as KeyStore.PrivateKeyEntry
    } else {
      generateKey(attestationChallenge)
    }

  private fun generateKey(attestationChallenge: String): KeyStore.PrivateKeyEntry {
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    val challengeBytes = attestationChallenge.toByteArray(Charsets.UTF_8)
    val builder =
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
      )
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA512)
        .setUserAuthenticationRequired(false)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      builder.setAttestationChallenge(challengeBytes)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
      reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
    ) {
      try {
        builder.setIsStrongBoxBacked(true)
      } catch (_: Throwable) {
        // Fall through to TEE-backed generation when StrongBox is unavailable for this key.
      }
    }

    generator.initialize(builder.build())
    generator.generateKeyPair()
    return keyStore.getEntry(KEY_ALIAS, null) as KeyStore.PrivateKeyEntry
  }

  private fun getKeyInfo(): KeyInfo {
    val privateKey = (keyStore.getEntry(KEY_ALIAS, null) as KeyStore.PrivateKeyEntry).privateKey as ECPrivateKey
    val keyFactory = KeyFactory.getInstance(privateKey.algorithm, "AndroidKeyStore")
    return keyFactory.getKeySpec(privateKey, KeyInfo::class.java) as KeyInfo
  }

  @Suppress("DEPRECATION")
  private fun resolveSecurityLevel(keyInfo: KeyInfo): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return when (keyInfo.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
        else -> "software"
      }
    }

    return if (keyInfo.isInsideSecureHardware) {
      "tee"
    } else {
      "software"
    }
  }

  private fun sha256(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
  }

  private fun supportsBleCentral(): Boolean =
    reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)

  private fun bluetoothAdapter(): BluetoothAdapter? {
    val bluetoothManager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    return bluetoothManager?.adapter
  }

  private fun nfcAdapter(): NfcAdapter? = NfcAdapter.getDefaultAdapter(reactContext)

  private fun supportsBlePeripheral(): Boolean {
    if (!supportsBleCentral()) {
      return false
    }

    return try {
      val bluetoothManager = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      bluetoothManager?.adapter?.isMultipleAdvertisementSupported == true
    } catch (_: SecurityException) {
      false
    } catch (_: Throwable) {
      false
    }
  }

  companion object {
    private const val MODULE_NAME = "AirPayNative"
    private const val KEY_ALIAS = "airpay_device_key"
  }
}
