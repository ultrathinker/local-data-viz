// Builds small synthetic data folders for the tests: CSV in subfolders, JSON lines, an Excel workbook (written by a tiny ZIP writer
// below, so the xlsx reader is tested against a file it did not write) and a few files the plugin must ignore.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data: string | Buffer, stored?: boolean }] -> Buffer of a ZIP archive. */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const stored = entry.stored === true;
    const body = stored ? data : zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const columnLetters = (index) => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/**
 * sheets: [{ name, hidden?, rows: [[cell, ...]] }]; a cell is a string, a number, a boolean, or { date: serial } for a date cell.
 * Strings go through the shared-strings table, as Excel does it.
 */
export function makeXlsx(sheets, { date1904 = false } = {}) {
  const shared = [];
  const sharedIndex = new Map();
  const stringId = (text) => {
    if (!sharedIndex.has(text)) {
      sharedIndex.set(text, shared.length);
      shared.push(text);
    }
    return sharedIndex.get(text);
  };
  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows.map((cells, r) => {
      const xml = cells
        .map((cell, c) => {
          const ref = `${columnLetters(c)}${r + 1}`;
          if (cell === null || cell === undefined || cell === '') return '';
          if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
          if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
          if (typeof cell === 'object' && cell.date !== undefined) return `<c r="${ref}" s="1"><v>${cell.date}</v></c>`;
          return `<c r="${ref}" t="s"><v>${stringId(String(cell))}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${xml}</row>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  });
  const entries = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets>${sheets
        .map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}"${sheet.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
  ];
  entries.push({
    name: 'xl/sharedStrings.xml',
    data: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
      .map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
      .join('')}</sst>`,
  });
  return makeZip(entries);
}

/** A small deterministic random generator, so the fixtures (and the expected numbers) never change. */
export function random(seed = 12345) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const REGIONS = ['North', 'South', 'East', 'West'];
const PRODUCTS = ['Chair', 'Desk', 'Lamp', 'Shelf', 'Sofa', 'Table'];
const CHANNELS = ['online', 'store', 'phone'];

const pad = (n) => String(n).padStart(2, '0');
const serialOf = (isoDay) => Math.round(Date.parse(`${isoDay}T00:00:00Z`) / 86400000) + 25569;

/**
 * Writes the sample folder and returns { root, orders, expected } where `expected` holds numbers computed in JS for the tests.
 * orders/2025/orders-2025-01.csv .. -06.csv (one table in six files), customers.json (JSON lines, dates as text),
 * budget.xlsx (Excel with a date column and a hidden sheet), readme.txt and logo.png (ignored).
 */
export function makeSampleFolder(root, { monthsOfOrders = 6, ordersPerMonth = 120 } = {}) {
  const rand = random(7);
  fs.mkdirSync(path.join(root, 'orders', '2025'), { recursive: true });
  const expected = { rows: 0, amount: 0, byRegion: {}, byMonth: {} };
  let orderId = 1000;
  for (let m = 1; m <= monthsOfOrders; m += 1) {
    const lines = ['order_id,order_date,region,product,channel,quantity,unit_price,amount,discount'];
    for (let i = 0; i < ordersPerMonth; i += 1) {
      const day = 1 + Math.floor(rand() * 28);
      const region = REGIONS[Math.floor(rand() * REGIONS.length)];
      const product = PRODUCTS[Math.floor(rand() * PRODUCTS.length)];
      const channel = CHANNELS[Math.floor(rand() * CHANNELS.length)];
      const quantity = 1 + Math.floor(rand() * 9);
      const unitPrice = Math.round((20 + rand() * 180) * 100) / 100;
      const amount = Math.round(quantity * unitPrice * 100) / 100;
      const discount = Math.round(rand() * 30) / 100;
      lines.push([orderId, `2025-${pad(m)}-${pad(day)}`, region, product, channel, quantity, unitPrice, amount, discount].join(','));
      orderId += 1;
      expected.rows += 1;
      expected.amount += amount;
      expected.byRegion[region] = (expected.byRegion[region] ?? 0) + amount;
      expected.byMonth[`2025-${pad(m)}`] = (expected.byMonth[`2025-${pad(m)}`] ?? 0) + amount;
    }
    fs.writeFileSync(path.join(root, 'orders', '2025', `orders-2025-${pad(m)}.csv`), `${lines.join('\n')}\n`);
  }

  const customers = [];
  const segments = ['consumer', 'business', 'education'];
  for (let i = 1; i <= 80; i += 1) {
    customers.push(JSON.stringify({ customer_id: `C${String(i).padStart(4, '0')}`, segment: segments[i % 3], signup_date: `2024-${pad(1 + (i % 12))}-${pad(1 + (i % 27))}`, lifetime_value: Math.round(rand() * 5000) / 10, active: i % 5 !== 0 }));
  }
  fs.writeFileSync(path.join(root, 'customers.json'), `${customers.join('\n')}\n`);

  const budgetRows = [['month', 'department', 'planned', 'actual']];
  for (let m = 1; m <= 6; m += 1) {
    for (const department of ['Sales', 'Support', 'Marketing']) {
      const planned = 1000 + m * 50 + department.length * 10;
      budgetRows.push([{ date: serialOf(`2025-${pad(m)}-01`) }, department, planned, planned + Math.round((rand() - 0.5) * 200)]);
    }
  }
  fs.writeFileSync(path.join(root, 'budget.xlsx'), makeXlsx([{ name: 'Budget', rows: budgetRows }, { name: 'Scratch', hidden: true, rows: [['a'], [1]] }]));

  fs.writeFileSync(path.join(root, 'readme.txt'), 'not data\n');
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([137, 80, 78, 71]));
  return { root, expected };
}
