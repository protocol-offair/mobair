package com.airpay.wallet.airpaynative

import android.nfc.cardemulation.HostApduService
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.os.Bundle

class AirPayHostApduService : HostApduService() {
  private var selectedFile: SelectedFile = SelectedFile.NONE

  override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
    val command = commandApdu ?: return STATUS_FILE_NOT_FOUND

    return when {
      command.contentEquals(SELECT_NDEF_APP) -> {
        selectedFile = SelectedFile.NONE
        STATUS_SUCCESS
      }

      command.contentEquals(SELECT_CC_FILE) -> {
        selectedFile = SelectedFile.CC
        STATUS_SUCCESS
      }

      command.contentEquals(SELECT_NDEF_FILE) -> {
        selectedFile = SelectedFile.NDEF
        STATUS_SUCCESS
      }

      command.size >= 5 && command[0] == 0x00.toByte() && command[1] == 0xB0.toByte() -> {
        handleReadBinary(command)
      }

      else -> STATUS_FILE_NOT_FOUND
    }
  }

  override fun onDeactivated(reason: Int) {
    selectedFile = SelectedFile.NONE
  }

  private fun handleReadBinary(command: ByteArray): ByteArray {
    val offset = ((command[2].toInt() and 0xFF) shl 8) or (command[3].toInt() and 0xFF)
    val length = command[4].toInt() and 0xFF
    val fileContents =
      when (selectedFile) {
        SelectedFile.CC -> CAPABILITY_CONTAINER
        SelectedFile.NDEF -> currentNdefFile()
        SelectedFile.NONE -> return STATUS_FILE_NOT_FOUND
      }

    if (offset > fileContents.size) {
      return STATUS_FILE_NOT_FOUND
    }

    val endIndex = minOf(offset + length, fileContents.size)
    return fileContents.copyOfRange(offset, endIndex) + STATUS_SUCCESS
  }

  private fun currentNdefFile(): ByteArray {
    val message = NdefMessage(arrayOf(NdefRecord.createTextRecord("en", AirPayHceState.bootstrapPayload)))
    val payload = message.toByteArray()
    val lengthHeader = byteArrayOf(
      ((payload.size shr 8) and 0xFF).toByte(),
      (payload.size and 0xFF).toByte(),
    )
    return lengthHeader + payload
  }

  private enum class SelectedFile {
    NONE,
    CC,
    NDEF,
  }

  companion object {
    private val STATUS_SUCCESS = byteArrayOf(0x90.toByte(), 0x00.toByte())
    private val STATUS_FILE_NOT_FOUND = byteArrayOf(0x6A.toByte(), 0x82.toByte())
    private val SELECT_NDEF_APP = hexToByteArray("00A4040007D276000085010100")
    private val SELECT_CC_FILE = hexToByteArray("00A4000C02E103")
    private val SELECT_NDEF_FILE = hexToByteArray("00A4000C02E104")
    private val CAPABILITY_CONTAINER = hexToByteArray("000F20003B00340406E104040000FF")

    private fun hexToByteArray(value: String): ByteArray {
      return value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
  }
}

