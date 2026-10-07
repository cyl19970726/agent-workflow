import { cp, mkdir } from 'node:fs/promises';

const destination = new URL('./dist/third-party/archify/', import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL('./third-party/archify/', import.meta.url), destination, { recursive: true });
