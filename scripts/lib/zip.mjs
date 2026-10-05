// A small reader for ZIP archives, just enough for .xlsx files: it finds the entries through the central directory and inflates the
// ones asked for. Nothing is ever written to disk from here, entry names are only looked up, and the inflated size is capped.

import zlib from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export const MAX_ENTRY_BYTES = 400 * 1024 * 1024;

/** Entries of the archive: Map of name -> { method, compressedSize, size, offset }. */
export function listZip(buffer, { maxEntries = 20_000 } = {}) {
  const last = buffer.length - 22;
  let eocd = -1;
  for (let i = last; i >= Math.max(0, last - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-directory record)');
  const total = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  if (total > maxEntries) throw new Error('the archive has too many entries');
  const entries = new Map();
  let position = directoryOffset;
  for (let index = 0; index < total; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) throw new Error('damaged ZIP central directory');
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const offset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString('utf8', position + 46, position + 46 + nameLength);
    entries.set(name, { method, compressedSize, size, offset });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The bytes of one entry, inflated; throws when it is larger than `maxBytes` or damaged. */
export function readEntry(buffer, entry, maxBytes = MAX_ENTRY_BYTES) {
  if (entry.size > maxBytes) throw new Error(`an entry is larger than ${Math.round(maxBytes / 1048576)} MB`);
  const at = entry.offset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new Error('damaged ZIP entry header');
  const dataStart = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) throw new Error(`unsupported ZIP compression method ${entry.method}`);
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(maxBytes, entry.size + 1024)) });
  } catch (error) {
    throw new Error(`cannot inflate a ZIP entry (${error.code ?? error.message})`);
  }
}
