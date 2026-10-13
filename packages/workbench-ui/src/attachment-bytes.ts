export async function verifiedAttachment(bytes: ArrayBuffer, expected: { sha256: string; size: number }): Promise<Uint8Array> {
  if (bytes.byteLength !== expected.size) throw new Error('附件字节数与保存记录不一致。');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.sha256.toLowerCase()) throw new Error('附件 SHA-256 与保存记录不一致。');
  return new Uint8Array(bytes);
}

export function readableByteSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} 字节` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Only passive media is opened inline; all other bytes remain download-only. */
export function inlineAttachmentType(mediaType: string): string | null {
  const type = mediaType.toLowerCase().split(';', 1)[0]?.trim() || '';
  return ['text/plain', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'video/mp4', 'video/webm'].includes(type) ? type : null;
}
