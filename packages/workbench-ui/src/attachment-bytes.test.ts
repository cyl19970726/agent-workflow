import { describe, expect, it } from 'vitest';
import { inlineAttachmentType, readableByteSize, verifiedAttachment } from './attachment-bytes.js';

describe('authorized attachment bytes', () => {
  it('accepts only the exact saved bytes and hash', async () => {
    const bytes = new TextEncoder().encode('hello').buffer;
    const saved = { sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', size: 5 };
    expect(await verifiedAttachment(bytes, saved)).toEqual(new Uint8Array(bytes));
    await expect(verifiedAttachment(bytes, { ...saved, size: 6 })).rejects.toThrow('字节数');
    await expect(verifiedAttachment(bytes, { ...saved, sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256');
  });
  it('keeps active formats download-only and displays saved sizes', () => {
    expect(inlineAttachmentType('image/png')).toBe('image/png');
    expect(inlineAttachmentType('text/html')).toBeNull();
    expect(inlineAttachmentType('image/svg+xml')).toBeNull();
    expect(readableByteSize(2048)).toBe('2.0 KiB');
  });
});
