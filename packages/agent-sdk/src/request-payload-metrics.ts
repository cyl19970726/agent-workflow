import { createHash } from "node:crypto";

type RecordLike = Record<string, unknown>;

export interface RequestPayloadMetrics {
  /** UTF-8 bytes in the exact JSON string sent as the HTTP request body. */
  requestBodyBytes: number;
  /** Number of input_image parts anywhere in the Responses input items. */
  inputImageOccurrences: number;
  /** Sorted hashes for unique inline images, using the runner's mimeType:base64 identity. */
  uniqueInputImageHashes: string[];
  /** Sum of decoded byte lengths for inline data URLs, counting every occurrence. */
  inlineImageDecodedBytes: number;
  /** UTF-8 bytes in function_call.arguments strings, counting each wire occurrence. */
  functionCallArgumentBytes: number;
  /** UTF-8 bytes in plain-string message content and input_text.text fields under input. */
  inputTextBytes: number;
  /** input_image parts whose image_url is not a supported inline image data URL. */
  nonInlineInputImageOccurrences: number;
}

const INLINE_IMAGE_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

/** Kept identical to the hash identity already emitted for SIWC visual inputs. */
export function inlineImageHash(mimeType: string, base64: string): string {
  return createHash("sha256").update(`${mimeType}:${base64}`).digest("hex");
}

/**
 * Measure one already-serialized Responses body without copying or retaining its contents.
 * Byte categories intentionally overlap and must not be added together: image data and
 * text/function arguments are already included in requestBodyBytes.
 */
export function measureRequestPayload(wireBody: unknown, serializedBody: string): RequestPayloadMetrics {
  const body = asRecord(wireBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const hashes = new Set<string>();
  let inputImageOccurrences = 0;
  let inlineImageDecodedBytes = 0;
  let functionCallArgumentBytes = 0;
  let inputTextBytes = 0;
  let nonInlineInputImageOccurrences = 0;

  for (const value of input) {
    const item = asRecord(value);
    if (!item) continue;
    if (item.type === "function_call" && typeof item.arguments === "string") {
      functionCallArgumentBytes += utf8Bytes(item.arguments);
    }
    if (typeof item.content === "string") inputTextBytes += utf8Bytes(item.content);
    if (!Array.isArray(item.content)) continue;
    for (const partValue of item.content) {
      const part = asRecord(partValue);
      if (!part) continue;
      if (part.type === "input_text" && typeof part.text === "string") inputTextBytes += utf8Bytes(part.text);
      if (part.type !== "input_image") continue;
      inputImageOccurrences++;
      if (typeof part.image_url !== "string") {
        nonInlineInputImageOccurrences++;
        continue;
      }
      const match = INLINE_IMAGE_URL.exec(part.image_url);
      if (!match) {
        nonInlineInputImageOccurrences++;
        continue;
      }
      const mimeType = match[1];
      const base64 = match[2];
      if (mimeType === undefined || base64 === undefined) {
        nonInlineInputImageOccurrences++;
        continue;
      }
      const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
      if (base64.length % 4 !== 0) {
        nonInlineInputImageOccurrences++;
        continue;
      }
      hashes.add(inlineImageHash(mimeType!, base64));
      inlineImageDecodedBytes += base64.length / 4 * 3 - padding;
    }
  }

  return {
    requestBodyBytes: utf8Bytes(serializedBody),
    inputImageOccurrences,
    uniqueInputImageHashes: [...hashes].sort(),
    inlineImageDecodedBytes,
    functionCallArgumentBytes,
    inputTextBytes,
    nonInlineInputImageOccurrences,
  };
}

function asRecord(value: unknown): RecordLike | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike : undefined;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
