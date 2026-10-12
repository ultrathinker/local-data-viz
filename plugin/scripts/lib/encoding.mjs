// UTF-16 text files (what Windows "Unicode" saves from Notepad and Excel) are not read by DuckDB's CSV reader. They are detected here and
// a UTF-8 copy is written into the work folder; the original is never touched.

import fs from 'node:fs';
import path from 'node:path';

/** 'utf-16le', 'utf-16be' or null: by the byte order mark, or by the zero bytes UTF-16 puts next to every ASCII character. */
export function sniffUtf16(buffer) {
  if (buffer.length >= 4 && ((buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0 && buffer[3] === 0) || (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 0xfe && buffer[3] === 0xff))) return null;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';
  const length = Math.min(buffer.length, 4096) - (Math.min(buffer.length, 4096) % 2);
  if (length < 8) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < length; i += 2) {
    if (buffer[i] === 0) even += 1;
    if (buffer[i + 1] === 0) odd += 1;
  }
  const pairs = length / 2;
  if (odd >= pairs * 0.3 && even <= pairs * 0.05) return 'utf-16le';
  if (even >= pairs * 0.3 && odd <= pairs * 0.05) return 'utf-16be';
  return null;
}

/** The encoding of a file when it is UTF-16 (reads the first 4 KB only), else null. */
export function utf16Encoding(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return sniffUtf16(head.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
}

function writeAll(fd, buffer) {
  let done = 0;
  while (done < buffer.length) done += fs.writeSync(fd, buffer, done, buffer.length - done);
}

/** Write `file` (UTF-16) as UTF-8 to the new file `target`, one megabyte at a time. The byte order mark is dropped. */
export function writeUtf8Copy(file, encoding, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const decoder = new TextDecoder('utf-16le');
  const input = fs.openSync(file, 'r');
  const output = fs.openSync(target, 'wx');
  try {
    const chunk = Buffer.alloc(1 << 20);
    let carry = Buffer.alloc(0);
    for (;;) {
      const read = fs.readSync(input, chunk, 0, chunk.length, null);
      if (read === 0) break;
      let bytes = Buffer.concat([carry, chunk.subarray(0, read)]);
      const odd = bytes.length % 2;
      carry = Buffer.from(bytes.subarray(bytes.length - odd));
      bytes = bytes.subarray(0, bytes.length - odd);
      if (encoding === 'utf-16be') bytes.swap16();
      const text = decoder.decode(bytes, { stream: true });
      if (text !== '') writeAll(output, Buffer.from(text, 'utf8'));
    }
    const rest = decoder.decode();
    if (rest !== '') writeAll(output, Buffer.from(rest, 'utf8'));
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

/**
 * A UTF-8 copy of a UTF-16 file inside `dir`, made once and reused. A copy counts only when its `.done` marker exists, so one that was
 * cut short is never trusted: the next name is tried instead (nothing is overwritten or removed).
 * Returns the path of the copy.
 */
export function utf8CopyOf(file, encoding, dir, baseName) {
  for (let n = 1; n < 100; n += 1) {
    const target = path.join(dir, `${baseName}${n === 1 ? '' : `-${n}`}.csv`);
    if (fs.existsSync(`${target}.done`)) return target;
    if (fs.existsSync(target)) continue;
    writeUtf8Copy(file, encoding, target);
    fs.writeFileSync(`${target}.done`, 'ok\n', { flag: 'wx' });
    return target;
  }
  throw new Error('too many unfinished copies in the work folder');
}
