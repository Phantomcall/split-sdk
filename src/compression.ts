import type { RequestInterceptor, ResponseInterceptor } from "./interceptors.js";
import { SdkError } from "./errors.js";

export type CompressionAlgorithm = "gzip" | "deflate";
export type CompressionPayload = string | Uint8Array;

export interface CompressionConfig {
  enabled: boolean;
  algorithm: CompressionAlgorithm;
}

export interface CompressedPayload {
  compressed: true;
  algorithm: CompressionAlgorithm;
  body: Uint8Array;
  originalBytes: number;
}

const MIN_COMPRESSION_BYTES = 1024;

function toBytes(payload: CompressionPayload): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
}

function isCompressionStreamAvailable(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof Response !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof (Blob.prototype as any).stream === "function"
  );
}

function isDecompressionStreamAvailable(): boolean {
  return (
    typeof DecompressionStream !== "undefined" &&
    typeof Response !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof (Blob.prototype as any).stream === "function"
  );
}

function isCompressedPayload(value: unknown): value is CompressedPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<CompressedPayload>;
  return candidate.compressed === true && candidate.body instanceof Uint8Array;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

async function compressInBrowser(bytes: Uint8Array, algorithm: CompressionAlgorithm): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream(algorithm));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompressInBrowser(bytes: Uint8Array, algorithm: CompressionAlgorithm): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream(algorithm));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function compressInNode(bytes: Uint8Array, algorithm: CompressionAlgorithm): Promise<Uint8Array> {
  const zlib = await import("node:zlib");
  const { promisify } = await import("node:util");
  const run = promisify(algorithm === "gzip" ? zlib.gzip : zlib.deflate);
  const compressed = await run(bytes);
  return new Uint8Array(compressed);
}

async function decompressInNode(bytes: Uint8Array, algorithm: CompressionAlgorithm): Promise<Uint8Array> {
  const zlib = await import("node:zlib");
  const { promisify } = await import("node:util");
  const run = promisify(algorithm === "gzip" ? zlib.gunzip : zlib.inflate);
  const decompressed = await run(bytes);
  return new Uint8Array(decompressed);
}

export async function compressPayload(
  payload: CompressionPayload,
  algorithm: CompressionAlgorithm = "gzip"
): Promise<CompressedPayload> {
  const bytes = toBytes(payload);
  const body = isCompressionStreamAvailable()
    ? await compressInBrowser(bytes, algorithm)
    : await compressInNode(bytes, algorithm);

  return {
    compressed: true,
    algorithm,
    body,
    originalBytes: bytes.byteLength,
  };
}

export async function decompressPayload(payload: CompressedPayload): Promise<Uint8Array> {
  return isDecompressionStreamAvailable()
    ? await decompressInBrowser(payload.body, payload.algorithm)
    : await decompressInNode(payload.body, payload.algorithm);
}

export function createCompressionRequestInterceptor(config: CompressionConfig): RequestInterceptor {
  return async (req) => {
    if (!config.enabled) {
      return req;
    }

    const params = await Promise.all(
      req.params.map(async (param) => {
        if (typeof param !== "string" && !(param instanceof Uint8Array)) {
          return param;
        }

        if (toBytes(param).byteLength <= MIN_COMPRESSION_BYTES) {
          return param;
        }

        return await compressPayload(param, config.algorithm);
      })
    );

    return { ...req, params };
  };
}

export function createCompressionResponseInterceptor(_config: CompressionConfig): ResponseInterceptor {
  return async (res) => {
    if (!isCompressedPayload(res.result)) {
      return res;
    }

    return {
      ...res,
      result: await decompressPayload(res.result),
    };
  };
}

/**
 * Serialize an object to JSON and encode as base64url (no padding).
 *
 * Throws {@link SdkError} with code `CONTRACT_REJECTED` if the resulting
 * base64 string exceeds `maxBytes` (default 512 bytes).
 *
 * @param obj - The object to compress.
 * @param maxBytes - Maximum allowed encoded size in bytes (default 512).
 * @returns The base64url-encoded JSON string (no padding).
 * @throws {SdkError} with code `CONTRACT_REJECTED` if the encoded string
 *   exceeds `maxBytes`.
 */
export function compressMetadata(
  obj: Record<string, unknown>,
  maxBytes: number = 512,
): string {
  const json = JSON.stringify(obj);
  const encoded = Buffer.from(json).toString("base64url");

  if (encoded.length > maxBytes) {
    throw new SdkError(
      `Encoded metadata exceeds ${maxBytes} bytes (got ${encoded.length})`,
      "CONTRACT_REJECTED",
    );
  }

  return encoded;
}

/**
 * Decode a base64url-encoded string and parse as JSON.
 *
 * Throws {@link SdkError} with code `CONTRACT_REJECTED` if the input is
 * not valid base64url or does not contain valid JSON.
 *
 * @param encoded - The base64url-encoded string to decode.
 * @returns The parsed object.
 * @throws {SdkError} with code `CONTRACT_REJECTED` if decoding or parsing
 *   fails.
 */
export function decompressMetadata(encoded: string): Record<string, unknown> {
  let json: string;
  try {
    json = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new SdkError(
      "Invalid base64url input",
      "CONTRACT_REJECTED",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SdkError(
      "Invalid JSON in decoded metadata",
      "CONTRACT_REJECTED",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SdkError(
      "Decoded metadata is not a plain object",
      "CONTRACT_REJECTED",
    );
  }

  return parsed as Record<string, unknown>;
}
