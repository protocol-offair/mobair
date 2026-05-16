package com.airpay.wallet.airpaynative

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.UUID

data class AirPayTransportIds(
  val serviceUuid: UUID,
  val handshakeCharacteristicUuid: UUID,
  val transferCharacteristicUuid: UUID,
  val receiptCharacteristicUuid: UUID,
  val closeCharacteristicUuid: UUID,
)

data class AirPayReceiverConfig(
  val sessionId: String,
  val bootstrapPayload: String,
  val transportIds: AirPayTransportIds,
)

class AirPayBlePeripheralManager(
  private val context: Context,
  private val emit: (String, WritableMap) -> Unit,
) {
  companion object {
    private const val TAG = "AirPayBlePeripheral"
    private const val STREAM_FRAME_DELAY_MS = 35L
    private val CLIENT_CONFIGURATION_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  }

  private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val adapter: BluetoothAdapter? = bluetoothManager.adapter
  private var advertiser: BluetoothLeAdvertiser? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var gattServer: BluetoothGattServer? = null
  private var handshakeCharacteristic: BluetoothGattCharacteristic? = null
  private var receiptCharacteristic: BluetoothGattCharacteristic? = null
  private var currentConfig: AirPayReceiverConfig? = null
  private var connectedDevice: BluetoothDevice? = null
  private var handshakeReadSnapshot: ByteArray = ByteArray(0)
  private var receiptReadSnapshot: ByteArray = ByteArray(0)
  private val buffers = mutableMapOf<String, MutableMap<Int, String>>()

  fun start(config: AirPayReceiverConfig) {
    stop()

    currentConfig = config
    if (adapter == null) {
      throw IllegalStateException("Bluetooth LE is unavailable on this device.")
    }
    if (!adapter.isEnabled) {
      throw IllegalStateException("Bluetooth is turned off. Enable Bluetooth before arming the AirPay receiver.")
    }
    advertiser = adapter?.bluetoothLeAdvertiser
      ?: throw IllegalStateException("Bluetooth LE advertiser is unavailable on this device.")
    gattServer = bluetoothManager.openGattServer(
      context,
      object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
          connectedDevice =
            if (newState == BluetoothGatt.STATE_CONNECTED) {
              device
            } else {
              null
            }

          emit(
            if (newState == BluetoothGatt.STATE_CONNECTED) "AirPayReceiverConnected" else "AirPayReceiverDisconnected",
            Arguments.createMap().apply {
              putString("sessionId", currentConfig?.sessionId)
              putString(
                "message",
                if (newState == BluetoothGatt.STATE_CONNECTED) {
                  "Sender connected to the AirPay BLE receiver."
                } else {
                  "Sender disconnected from the AirPay BLE receiver."
                },
              )
            },
          )
        }

        override fun onCharacteristicWriteRequest(
          device: BluetoothDevice,
          requestId: Int,
          characteristic: BluetoothGattCharacteristic,
          preparedWrite: Boolean,
          responseNeeded: Boolean,
          offset: Int,
          value: ByteArray?,
        ) {
          val payload = value?.toString(StandardCharsets.UTF_8).orEmpty()
          val kind =
            when (characteristic.uuid) {
              currentConfig?.transportIds?.handshakeCharacteristicUuid -> "handshake"
              currentConfig?.transportIds?.transferCharacteristicUuid -> "transfer"
              currentConfig?.transportIds?.closeCharacteristicUuid -> "close"
              else -> "unknown"
            }

          Log.d(
            TAG,
            "write kind=$kind requestId=$requestId offset=$offset bytes=${value?.size ?: 0} responseNeeded=$responseNeeded",
          )

          if (kind == "close") {
            Log.i(TAG, "close received session=${currentConfig?.sessionId}")
            emit(
              "AirPaySessionClosed",
              Arguments.createMap().apply {
                putString("sessionId", currentConfig?.sessionId)
                putString("messageCode", "sender_closed")
              },
            )
            if (responseNeeded) {
              gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
            return
          }

          val frame =
            try {
              JSONObject(payload)
            } catch (error: Throwable) {
              emit(
                "AirPayNativeError",
                Arguments.createMap().apply {
                  putString("sessionId", currentConfig?.sessionId)
                  putString("message", "Received malformed BLE frame for $kind: ${error.message}")
                },
              )
              if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
              }
              return
            }

          val assembledPayload =
            try {
              val frameSessionId = frame.getString("sessionId")
              val chunkIndex = frame.getInt("chunkIndex")
              val totalChunks = frame.getInt("totalChunks")
              Log.d(TAG, "frame kind=$kind session=$frameSessionId chunk=${chunkIndex + 1}/$totalChunks")
              storeFrame(
                frameSessionId,
                kind,
                chunkIndex,
                totalChunks,
                frame.getString("chunk"),
              )
            } catch (error: Throwable) {
              emit(
                "AirPayNativeError",
                Arguments.createMap().apply {
                  putString("sessionId", currentConfig?.sessionId)
                  putString("message", "Unable to assemble BLE frame for $kind: ${error.message}")
                },
              )
              if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
              }
              return
            }

          if (responseNeeded) {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
          }

          if (assembledPayload != null) {
            Log.i(
              TAG,
              "assembled kind=$kind session=${frame.getString("sessionId")} chars=${assembledPayload.length}",
            )
            emit(
              if (kind == "handshake") "AirPayHandshakeReceived" else "AirPayTransferReceived",
              Arguments.createMap().apply {
                putString("sessionId", frame.getString("sessionId"))
                putString("payload", assembledPayload)
              },
            )
          }
        }

        override fun onCharacteristicReadRequest(
          device: BluetoothDevice,
          requestId: Int,
          offset: Int,
          characteristic: BluetoothGattCharacteristic,
        ) {
          val value =
            when (characteristic.uuid) {
              currentConfig?.transportIds?.handshakeCharacteristicUuid -> handshakeReadSnapshot
              currentConfig?.transportIds?.receiptCharacteristicUuid -> receiptReadSnapshot
              else -> characteristic.value ?: ByteArray(0)
            }
          val responseValue =
            if (offset < value.size) {
              value.copyOfRange(offset, value.size)
            } else {
              ByteArray(0)
            }

          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, responseValue)
        }

        override fun onDescriptorWriteRequest(
          device: BluetoothDevice,
          requestId: Int,
          descriptor: BluetoothGattDescriptor,
          preparedWrite: Boolean,
          responseNeeded: Boolean,
          offset: Int,
          value: ByteArray?,
        ) {
          descriptor.value = value ?: ByteArray(0)
          if (responseNeeded) {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
          }

          if (descriptor.uuid != CLIENT_CONFIGURATION_UUID) {
            return
          }

          val notificationsEnabled = value?.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == true
          if (!notificationsEnabled) {
            Log.d(TAG, "notifications disabled characteristic=${descriptor.characteristic.uuid}")
            return
          }

          when (descriptor.characteristic.uuid) {
            currentConfig?.transportIds?.handshakeCharacteristicUuid -> {
              val characteristic = handshakeCharacteristic ?: return
              val config = currentConfig ?: return
              Log.i(TAG, "notifications enabled kind=bootstrap session=${config.sessionId}")
              streamPayload(device, characteristic, config.sessionId, config.bootstrapPayload, "bootstrap")
            }
            currentConfig?.transportIds?.receiptCharacteristicUuid -> {
              val characteristic = receiptCharacteristic ?: return
              val config = currentConfig ?: return
              Log.i(
                TAG,
                "notifications enabled kind=receipt session=${config.sessionId} snapshotBytes=${receiptReadSnapshot.size}",
              )
              if (receiptReadSnapshot.isNotEmpty()) {
                streamPayload(
                  device,
                  characteristic,
                  config.sessionId,
                  receiptReadSnapshot.toString(StandardCharsets.UTF_8),
                  "receipt-snapshot",
                )
              }
            }
          }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
          if (status != BluetoothGatt.GATT_SUCCESS) {
            Log.w(TAG, "notification sent with non-success status=$status device=${device.address}")
          }
        }

        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
          val config = currentConfig ?: return
          if (service.uuid != config.transportIds.serviceUuid) {
            return
          }
          if (status != BluetoothGatt.GATT_SUCCESS) {
            emit(
              "AirPayNativeError",
              Arguments.createMap().apply {
                putString("sessionId", config.sessionId)
                putString("message", "BLE GATT service registration failed with status $status.")
              },
            )
            return
          }

          startAdvertising(config)
        }
      },
    ) ?: throw IllegalStateException("Unable to open a BLE GATT server.")

    val service = BluetoothGattService(config.transportIds.serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    val handshakeChar = BluetoothGattCharacteristic(
      config.transportIds.handshakeCharacteristicUuid,
      BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_READ or BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    val transferCharacteristic = BluetoothGattCharacteristic(
      config.transportIds.transferCharacteristicUuid,
      BluetoothGattCharacteristic.PROPERTY_WRITE,
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    val receiptChar = BluetoothGattCharacteristic(
      config.transportIds.receiptCharacteristicUuid,
      BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_READ,
    )
    val closeCharacteristic = BluetoothGattCharacteristic(
      config.transportIds.closeCharacteristicUuid,
      BluetoothGattCharacteristic.PROPERTY_WRITE,
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )

    handshakeChar.addDescriptor(
      BluetoothGattDescriptor(
        CLIENT_CONFIGURATION_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    receiptChar.addDescriptor(
      BluetoothGattDescriptor(
        CLIENT_CONFIGURATION_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )

    handshakeCharacteristic = handshakeChar
    receiptCharacteristic = receiptChar

    service.addCharacteristic(handshakeChar)
    service.addCharacteristic(transferCharacteristic)
    service.addCharacteristic(receiptChar)
    service.addCharacteristic(closeCharacteristic)
    handshakeReadSnapshot = config.bootstrapPayload.toByteArray(StandardCharsets.UTF_8)
    receiptReadSnapshot = ByteArray(0)
    handshakeChar.value = handshakeReadSnapshot

    val serviceAccepted = gattServer?.addService(service) == true
    if (!serviceAccepted) {
      throw IllegalStateException("Unable to register the AirPay BLE GATT service.")
    }
  }

  private fun startAdvertising(config: AirPayReceiverConfig) {
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .build()
    val data = AdvertiseData.Builder()
      .addServiceUuid(ParcelUuid(config.transportIds.serviceUuid))
      .setIncludeDeviceName(false)
      .build()
    val scanResponse = AdvertiseData.Builder()
      .addServiceData(ParcelUuid(config.transportIds.serviceUuid), "AirPay".toByteArray(StandardCharsets.UTF_8))
      .build()

    advertiseCallback =
      object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
          emit(
            "AirPayReceiverReady",
            Arguments.createMap().apply {
              putString("sessionId", config.sessionId)
              putString("message", "BLE advertising is ready for the AirPay receiver. NFC bootstrap is used when available.")
            },
          )
        }

        override fun onStartFailure(errorCode: Int) {
          emit(
            "AirPayNativeError",
            Arguments.createMap().apply {
              putString("sessionId", config.sessionId)
              putString("message", "BLE advertising failed with code $errorCode.")
            },
          )
        }
      }

    advertiser?.startAdvertising(settings, data, scanResponse, advertiseCallback)
  }

  fun publishReceipt(sessionId: String, receiptPayload: String) {
    if (currentConfig?.sessionId != sessionId) {
      throw IllegalStateException("Receipt session id does not match the active receiver session.")
    }

    receiptReadSnapshot = receiptPayload.toByteArray(StandardCharsets.UTF_8)
    receiptCharacteristic?.value = receiptReadSnapshot
    val device = connectedDevice
    val characteristic = receiptCharacteristic
    Log.i(
      TAG,
      "publishReceipt session=$sessionId chars=${receiptPayload.length} bytes=${receiptReadSnapshot.size} hasDevice=${device != null} hasCharacteristic=${characteristic != null}",
    )
    if (device != null && characteristic != null) {
      streamPayload(device, characteristic, sessionId, receiptPayload, "receipt")
    }
  }

  fun stop() {
    advertiseCallback?.let { callback ->
      advertiser?.stopAdvertising(callback)
    }
    advertiseCallback = null
    advertiser = null
    gattServer?.close()
    gattServer = null
    handshakeCharacteristic = null
    receiptCharacteristic = null
    connectedDevice = null
    currentConfig = null
    handshakeReadSnapshot = ByteArray(0)
    receiptReadSnapshot = ByteArray(0)
    buffers.clear()
  }

  private fun streamPayload(
    device: BluetoothDevice,
    characteristic: BluetoothGattCharacteristic,
    sessionId: String,
    payload: String,
    kind: String,
  ) {
    val server = gattServer ?: return
    val frames = chunkOutboundPayload(sessionId, payload)

    Thread {
      Log.i(TAG, "stream start kind=$kind session=$sessionId frames=${frames.size} chars=${payload.length}")
      frames.forEachIndexed { index, frameBytes ->
        if (connectedDevice?.address != device.address || currentConfig?.sessionId != sessionId) {
          Log.w(TAG, "stream aborted kind=$kind session=$sessionId frame=${index + 1}/${frames.size}")
          return@Thread
        }

        characteristic.value = frameBytes
        val notified = server.notifyCharacteristicChanged(device, characteristic, false)
        if (!notified) {
          emit(
            "AirPayNativeError",
            Arguments.createMap().apply {
              putString("sessionId", sessionId)
              putString("message", "BLE $kind stream notification failed at frame ${index + 1}/${frames.size}.")
            },
          )
          return@Thread
        }

        try {
          Thread.sleep(STREAM_FRAME_DELAY_MS)
        } catch (_: InterruptedException) {
          return@Thread
        }
      }
      Log.i(TAG, "stream complete kind=$kind session=$sessionId frames=${frames.size}")
    }.start()
  }

  private fun chunkOutboundPayload(sessionId: String, payload: String): List<ByteArray> {
    val encodedPayload = Base64.encodeToString(payload.toByteArray(StandardCharsets.UTF_8), Base64.NO_WRAP)
    val chunkSize = 120
    val totalChunks = maxOf(1, (encodedPayload.length + chunkSize - 1) / chunkSize)

    return List(totalChunks) { index ->
      JSONObject().apply {
        put("sessionId", sessionId)
        put("chunkIndex", index)
        put("totalChunks", totalChunks)
        put("chunk", encodedPayload.substring(index * chunkSize, minOf(encodedPayload.length, (index + 1) * chunkSize)))
      }.toString().toByteArray(StandardCharsets.UTF_8)
    }
  }

  private fun storeFrame(
    sessionId: String,
    kind: String,
    chunkIndex: Int,
    totalChunks: Int,
    chunk: String,
  ): String? {
    val key = "$sessionId:$kind"
    val bucket = buffers.getOrPut(key) { mutableMapOf() }
    bucket[chunkIndex] = chunk

    if (bucket.size != totalChunks) {
      return null
    }

    val merged = buildString {
      for (index in 0 until totalChunks) {
        append(bucket[index].orEmpty())
      }
    }
    buffers.remove(key)
    return String(Base64.decode(merged, Base64.NO_WRAP), StandardCharsets.UTF_8)
  }
}
