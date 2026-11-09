// Plain text from the files schools attach (weekly plans as PDF or Word), with no
// dependencies: PDF through poppler's `pdftotext` (on most Linux desktops), Word (.docx) by
// reading the zip and its XML directly. Tables come out one row per line, cells split by tabs,
// so a plan with the weekdays as columns or rows keeps its shape.

import { execFile } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

// One file out of a zip (a .docx is one), found through the central directory.
export function unzipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`zip method ${method} not supported`);
    }
    p += 46 + nameLen + extra + comment;
  }
  return null;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));

// The words of a .docx: paragraphs on their own lines, table rows as tab-separated cells.
export function docxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml')?.toString('utf8');
  if (!xml) throw new Error('no document in this .docx');
  const para = (p) => unxml([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br)\b[^>]*\/>/g)].map((m) => (m[1] != null ? m[1] : m[2] === 'tab' ? ' ' : '\n')).join(''));
  const cell = (c) => [...c.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((m) => para(m[0])).filter((t) => t.trim()).join(' / ');
  const out = [];
  // Walk the body in order: a table becomes rows of cells; a paragraph outside one, a line.
  const body = xml.slice(xml.indexOf('<w:body'));
  const re = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  for (const m of body.matchAll(re)) {
    if (m[0].startsWith('<w:tbl')) {
      for (const row of m[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) out.push([...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => cell(c[0]).replace(/\t/g, ' ')).join('\t'));
    } else out.push(para(m[0]));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The words of a PDF, laid out as on the page (columns kept apart by spaces).
export function pdfText(buf, { bin = process.env.PDFTOTEXT_BIN || 'pdftotext', timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, ['-layout', '-enc', 'UTF-8', '-', '-'], { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (e, stdout) => {
      if (e) return reject(e.code === 'ENOENT' ? new Error('pdftotext is not installed (poppler-utils)') : e);
      // Only blank lines go from the start: the first line's indent is where its columns are.
      resolve(stdout.replace(/\f/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd());
    });
    child.stdin.end(buf);
  });
}

// Text from a PDF or Word file, by its name or type; null for anything else.
export async function documentText(buf, { name = '', type = '' } = {}) {
  if (/pdf/i.test(type) || /\.pdf$/i.test(name) || buf.subarray(0, 5).toString() === '%PDF-') return pdfText(buf);
  if (/wordprocessingml/i.test(type) || /\.docx$/i.test(name)) return docxText(buf);
  return null;
}
