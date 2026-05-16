import "react-native-get-random-values";

import { Buffer } from "buffer";

type GlobalWithBuffer = typeof globalThis & {
  Buffer?: typeof Buffer;
};

const globalWithBuffer = globalThis as GlobalWithBuffer;

if (!globalWithBuffer.Buffer) {
  globalWithBuffer.Buffer = Buffer;
}
