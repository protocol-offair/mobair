import { Buffer } from "buffer";

export function encodeUtf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function decodeUtf8(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

