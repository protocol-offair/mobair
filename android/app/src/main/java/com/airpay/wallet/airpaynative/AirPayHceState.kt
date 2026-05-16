package com.airpay.wallet.airpaynative

object AirPayHceState {
  @Volatile
  var bootstrapPayload: String = "{\"status\":\"idle\"}"
}

