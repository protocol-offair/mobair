import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import nacl from "tweetnacl";
import { Buffer } from "buffer";

import { canonicalStringify } from "@airpay/shared";

const LOCAL_TRANSPORT_KEYPAIR_STORAGE_KEY = "airpay.transport.keypair";

interface RuntimeExtraConfig {
  backendTransportPublicKey?: string;
}

interface StoredTransportKeypair {
  publicKey: string;
  secretKey: string;
  createdAt: string;
}

export interface SecureTransportEnvelope {
  secureTransport: true;
  version: 1;
  scheme: "nacl-box";
  context: string;
  senderPublicKey: string;
  nonce: string;
  ciphertext: string;
}

export interface DecryptedTransportPayload {
  plaintext: string;
  senderPublicKey: string;
  context: string;
}

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function getBackendTransportPublicKey(): string | undefined {
  const extra = (Constants.expoConfig?.extra ?? {}) as RuntimeExtraConfig;
  return extra.backendTransportPublicKey;
}

function serializePayload(payload: unknown): string {
  return typeof payload === "string" ? payload : canonicalStringify(payload);
}

function assertKeyLength(label: string, bytes: Uint8Array) {
  if (bytes.length !== nacl.box.publicKeyLength) {
    throw new Error(`${label} must be ${nacl.box.publicKeyLength} bytes.`);
  }
}

function normalizeEnvelope(value: unknown): SecureTransportEnvelope {
  if (!isSecureTransportEnvelope(value)) {
    throw new Error("Secure transport envelope is malformed.");
  }

  return value;
}

async function readStoredTransportKeypair(): Promise<StoredTransportKeypair | null> {
  const raw = await SecureStore.getItemAsync(LOCAL_TRANSPORT_KEYPAIR_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as StoredTransportKeypair;
    if (!parsed.publicKey || !parsed.secretKey) {
      return null;
    }
    assertKeyLength("Stored transport public key", fromBase64(parsed.publicKey));
    assertKeyLength("Stored transport secret key", fromBase64(parsed.secretKey));
    return parsed;
  } catch {
    return null;
  }
}

async function getOrCreateLocalTransportKeypair(): Promise<StoredTransportKeypair> {
  const existing = await readStoredTransportKeypair();
  if (existing) {
    return existing;
  }

  const keypair = nacl.box.keyPair();
  const created: StoredTransportKeypair = {
    publicKey: toBase64(keypair.publicKey),
    secretKey: toBase64(keypair.secretKey),
    createdAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(LOCAL_TRANSPORT_KEYPAIR_STORAGE_KEY, JSON.stringify(created));
  return created;
}

export async function getLocalTransportPublicKey(): Promise<string> {
  return (await getOrCreateLocalTransportKeypair()).publicKey;
}

export function isSecureTransportEnvelope(value: unknown): value is SecureTransportEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SecureTransportEnvelope>;
  return (
    candidate.secureTransport === true &&
    candidate.version === 1 &&
    candidate.scheme === "nacl-box" &&
    typeof candidate.context === "string" &&
    typeof candidate.senderPublicKey === "string" &&
    typeof candidate.nonce === "string" &&
    typeof candidate.ciphertext === "string"
  );
}

export async function encryptForPeerPayload(
  payload: unknown,
  peerPublicKey: string,
  context: string,
): Promise<SecureTransportEnvelope> {
  const localKeypair = await getOrCreateLocalTransportKeypair();
  const peerPublicKeyBytes = fromBase64(peerPublicKey);
  const localSecretKeyBytes = fromBase64(localKeypair.secretKey);
  assertKeyLength("Peer transport public key", peerPublicKeyBytes);
  assertKeyLength("Local transport secret key", localSecretKeyBytes);

  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    new TextEncoder().encode(serializePayload(payload)),
    nonce,
    peerPublicKeyBytes,
    localSecretKeyBytes,
  );

  return {
    secureTransport: true,
    version: 1,
    scheme: "nacl-box",
    context,
    senderPublicKey: localKeypair.publicKey,
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext),
  };
}

export async function decryptPeerPayload(
  envelopeInput: SecureTransportEnvelope | unknown,
  options: {
    expectedContext: string;
    expectedPeerPublicKey?: string;
  },
): Promise<DecryptedTransportPayload> {
  const envelope = normalizeEnvelope(envelopeInput);
  if (envelope.context !== options.expectedContext) {
    throw new Error(`Secure transport context mismatch. Expected ${options.expectedContext}, got ${envelope.context}.`);
  }
  if (options.expectedPeerPublicKey && envelope.senderPublicKey !== options.expectedPeerPublicKey) {
    throw new Error("Secure transport sender public key mismatch.");
  }

  const localKeypair = await getOrCreateLocalTransportKeypair();
  const message = nacl.box.open(
    fromBase64(envelope.ciphertext),
    fromBase64(envelope.nonce),
    fromBase64(envelope.senderPublicKey),
    fromBase64(localKeypair.secretKey),
  );
  if (!message) {
    throw new Error("Secure transport decryption failed.");
  }

  return {
    plaintext: new TextDecoder().decode(message),
    senderPublicKey: envelope.senderPublicKey,
    context: envelope.context,
  };
}

async function encryptForServerPayload(payload: unknown, context: string): Promise<SecureTransportEnvelope | null> {
  const backendPublicKey = getBackendTransportPublicKey();
  if (!backendPublicKey) {
    return null;
  }

  return encryptForPeerPayload(payload, backendPublicKey, context);
}

async function parseMaybeSecureResponseText<T>(
  response: Response,
  responseContext: string,
  fallbackContext: string,
): Promise<T> {
  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`${fallbackContext} returned an empty response body (${response.status}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(
      `${fallbackContext} returned invalid JSON (${response.status}). ${error instanceof Error ? error.message : "Unknown parse error."}`,
    );
  }

  if (isSecureTransportEnvelope(parsed)) {
    const decrypted = await decryptPeerPayload(parsed, {
      expectedContext: responseContext,
      expectedPeerPublicKey: getBackendTransportPublicKey(),
    });

    try {
      return JSON.parse(decrypted.plaintext) as T;
    } catch (error) {
      throw new Error(
        `${fallbackContext} returned an invalid secure JSON payload (${response.status}). ${error instanceof Error ? error.message : "Unknown parse error."}`,
      );
    }
  }

  return parsed as T;
}

export async function readMaybeSecureErrorResponse(
  response: Response,
  responseContext: string,
  fallbackContext: string,
): Promise<string> {
  try {
    const parsed = await parseMaybeSecureResponseText<{ detail?: string; error?: string; message?: string }>(
      response,
      responseContext,
      fallbackContext,
    );
    return parsed.detail ?? parsed.error ?? parsed.message ?? `${fallbackContext} failed with HTTP ${response.status}.`;
  } catch (error) {
    return error instanceof Error ? error.message : `${fallbackContext} failed with HTTP ${response.status}.`;
  }
}

export async function postMaybeSecureJson<TResponse>(input: {
  url: string;
  payload: unknown;
  context: string;
  headers?: Record<string, string>;
}): Promise<TResponse> {
  const requestContext = `${input.context}.request`;
  const responseContext = `${input.context}.response`;
  const secureEnvelope = await encryptForServerPayload(input.payload, requestContext);
  const response = await fetch(input.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...input.headers,
    },
    body: JSON.stringify(secureEnvelope ?? input.payload),
  });

  if (!response.ok) {
    throw new Error(await readMaybeSecureErrorResponse(response, responseContext, input.context));
  }

  return parseMaybeSecureResponseText<TResponse>(response, responseContext, input.context);
}
