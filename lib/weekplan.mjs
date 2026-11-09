// A school's weekly plan ("ukeplan") as calendar events, by script: the text of the PDF or
// Word file (pdftotext -layout keeps the table's columns lined up), read as a table with the
// weekdays as columns. What's the same every day (frilek, lunsj, storefri) is left out; what
// differs (a trip, gym, a theme day), when the day ends and the homework due become events.
//
//   weekPlanEvents(text, { sentAt, title }) → [{ day: 'YYYY-MM-DD', title, start?, end?, allDay?, kind }]
//
// kind: 'activity' (a cell that isn't routine), 'ends' (when the school day ends), 'homework'
// (due that day; span: 'week' when it's the week's homework, worked on over the week).
// Plans with no weekday header give nothing.

// Bumped when the parsing changes, so plans read before are read again.
export const VERSION = 6;

const DAYS = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag'];
const DAY_RE = new RegExp(`\\b(${DAYS.join('|')})\\b`, 'gi');
// Things on every school day that aren't news to a parent.
const ROUTINE = /^(frilek|lillefri|storefri|lunsj|stilleles|friminutt|brødmat|varmmat|knekkebrød|& frukt|frukt|samling|lesestund|frilek inne\/ute)\b/i;
// A lesson that's just its subject is the timetable, not news.
const SUBJECT = /^(norsk|matte|matematikk|engelsk|naturfag|samfunnsfag|krle|musikk|kunst og håndverk|k&h|mat og helse|lesing|skriving)\.?$/i;
const TIME_RANGE = /^(\d{1,2})[.:](\d{2})\s*[-–]\s*(\d{1,2})[.:](\d{2})$/;
// Short words a wrapped cell leaves on a line of their own.
const CONNECTOR = /^(på|eller|og|i|til|med)$/i;
const TIME_FROM = /^\d{1,2}[.:]\d{2}\s*[-–]$/;
const TIME_ONLY = /^\d{1,2}[.:]\d{2}$/;
const TIME = /\b(\d{1,2})[.:](\d{2})\b/;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const clean = (s) => s.replace(/&(\w+);/g, (m, e) => ENT[e] ?? m).replace(/\s+/g, ' ').trim();

// A line's chunks: runs of text separated by two or more spaces, with where they start and end.
function chunks(line) {
  const out = [];
  for (const m of line.matchAll(/\S+(?: \S+)*/g)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

// Monday of ISO week `week` in `year`.
export function isoMonday(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mon = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 864e5);
  return new Date(mon.getTime() + (week - 1) * 7 * 864e5);
}
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return { year: t.getUTCFullYear(), week: 1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7) };
}

// Which week a plan is for: "uke 45" in it or its title, in the year it was sent (or the next,
// sent in December for January); otherwise the coming week when sent Friday to Sunday.
export function planMonday(text, { sentAt, title = '' } = {}) {
  const sent = new Date(sentAt || Date.now());
  const n = Number((`${title}\n${text}`.match(/\buke\s*(\d{1,2})\b/i) || [])[1]);
  if (n >= 1 && n <= 53) {
    const { year, week } = isoWeek(sent);
    return isoMonday(week > 40 && n < 10 ? year + 1 : week < 10 && n > 40 ? year - 1 : year, n);
  }
  const { year, week } = isoWeek(sent);
  const dow = (sent.getUTCDay() + 6) % 7; // 0 = Monday
  return isoMonday(year, week + (dow >= 4 ? 1 : 0));
}

const ymd = (d) => d.toISOString().slice(0, 10);
const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

// The weekday columns a line heads, when it's a table header: three or more days, each
// starting a chunk of its own ("Mandag", "Til tirsdag"). A sentence that names days isn't one.
function headerCols(line) {
  const cols = [];
  for (const c of chunks(line)) {
    const m = c.text.match(/^(?:til\s+|uke\s*\d+\s+)?(mandag|tirsdag|onsdag|torsdag|fredag)\b/i);
    if (!m) continue;
    const at = c.start + c.text.toLowerCase().indexOf(m[1].toLowerCase());
    cols.push({ day: DAYS.indexOf(m[1].toLowerCase()), center: at + m[1].length / 2, start: at });
  }
  return new Set(cols.map((c) => c.day)).size >= 3 ? cols : null;
}

// Every table in the text with the weekdays as its columns.
function tables(lines, repeated) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = headerCols(lines[i]);
    if (!cols) continue;
    // "Til tirsdag" columns are homework due that day.
    const homework = /\btil\s+(mandag|tirsdag|onsdag|torsdag|fredag)\b/i.test(lines[i]);
    let end = i + 1;
    let blanks = 0;
    for (; end < lines.length; end++) {
      const l = lines[end];
      if (lines.tabbed?.has(i) && l.trim() && !lines.tabbed.has(end)) break; // a Word table ends where its rows do
      if (headerCols(l)) break;
      if (!l.trim()) { if (++blanks >= 8) break; continue; } // a page break leaves a few
      if (repeated.has(l.trim())) continue; // and the page header again
      blanks = 0;
      // Prose under the table (a heading, a paragraph) starts left of the columns and runs across them.
      const cs = chunks(l);
      if (cs.length === 1 && cs[0].start > 0 && cs[0].start < cols[0].start - 2 && cs[0].end > cols[1].center && !TIME_RANGE.test(cs[0].text)) break;
      if (cs.length === 1 && cs[0].end < cols[0].start - 2 && /^[A-ZÆØÅ][a-zæøå]+$/.test(cs[0].text) && !/^(slutter|norsk|matte|matematikk|engelsk)$/i.test(cs[0].text)) break;
    }
    out.push({ header: i, cols, homework, lines: lines.slice(i + 1, end) });
    i = end - 1;
  }
  return out;
}

const isLabel = (t) => TIME_RANGE.test(t) || TIME_FROM.test(t) || TIME_ONLY.test(t) || (/^[\wæøå]{1,12}\.?$/i.test(t) && !CONNECTOR.test(t));

// The cells of a table: for each line, its row label (left of the first column, when it's a
// time range or a short word) and each column's text.
function cellsOf(t, repeated) {
  const left = t.cols[0].start - 2;
  const nearest = (center) => t.cols.reduce((a, b) => (Math.abs(b.center - center) < Math.abs(a.center - center) ? b : a));
  // Where cells start in each column, from the lines: two cells that touch ("Futsalturnering
  // Futsalturnering") are split where the second column's cells start.
  const starts = new Map();
  for (const l of t.lines) for (const c of chunks(l)) if (c.end > left) starts.set(c.start, (starts.get(c.start) || 0) + 1);
  const cellStart = new Set([...starts].filter(([, n]) => n >= 2).map(([at]) => at));
  const split = (c) => {
    const out = [];
    let cur = null;
    for (const w of c.text.matchAll(/\S+/g)) {
      const at = c.start + w.index;
      if (cur && [-2, -1, 0, 1, 2].some((d) => cellStart.has(at + d)) && nearest(at + 4).day !== nearest(cur.start + 4).day) { out.push(cur); cur = null; }
      if (!cur) cur = { text: w[0], start: at, end: at + w[0].length };
      else Object.assign(cur, { text: `${cur.text} ${w[0]}`, end: at + w[0].length });
    }
    if (cur) out.push(cur);
    return out;
  };
  const rows = [];
  for (const l of t.lines) {
    if (!l.trim()) { rows.push(null); continue; }
    if (repeated.has(l.trim())) continue; // a page header printed again on the next page
    const row = { label: null, cells: {} };
    const cs = chunks(l).flatMap((c) => (c.end > left ? split(c) : [c]));
    for (const c of cs.filter((x) => x.end <= left)) if (isLabel(c.text)) row.label = c.text;
    // One chunk per column: in that order, even when the page put the table further left
    // (a table that runs onto the next page often starts at the margin there).
    const body = cs.filter((c) => c.end > left);
    if (body.length === t.cols.length && body.length > 1) {
      body.forEach((c, i) => { row.cells[t.cols[i].day] = c.text; });
    } else {
      // Otherwise by where it is; a side column of prose (DIVERSE) left of the days isn't part of any.
      for (const c of body) {
        const col = nearest((c.start + c.end) / 2);
        row.cells[col.day] = row.cells[col.day] ? `${row.cells[col.day]} ${c.text}` : c.text;
      }
    }
    rows.push(row);
  }
  // A time range split over two lines ("08.30-", then "09.15") is one.
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a?.label && TIME_FROM.test(a.label) && b?.label && TIME_ONLY.test(b.label)) { a.label += b.label; b.label = null; }
  }
  return rows;
}

// A Word table comes out with its cells separated by tabs: line those up in columns, as
// pdftotext does, so both read the same way.
function untab(lines) {
  const width = [];
  for (const l of lines) if (l.includes('\t')) l.split('\t').forEach((c, i) => { width[i] = Math.max(width[i] || 0, c.trim().length + 4); });
  const out = lines.map((l) => (l.includes('\t') ? l.split('\t').map((c, i) => c.trim().padEnd(width[i])).join('').trimEnd() : l));
  out.tabbed = new Set(lines.flatMap((l, i) => (l.includes('\t') ? [i] : [])));
  return out;
}

// Homework as a list under the week rather than a table by day (older classes):
//
//   Lekser           Innlevering torsdag
//   Matte            Oppgaver med de fire regneartene. Oppgavene ligger i OneNote.
//   Norsk            Les tegneserien …
//
// Each subject on the left is due the day named on the "Lekser" line; the text to its right,
// over as many lines as it takes, is the assignment.
const DUE = new RegExp(`^\\s*lekser?\\b(.*)\\b(${DAYS.join('|')})\\b`, 'i');
function homeworkList(lines, repeated, dayOf) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DUE);
    if (!m || (lines[i].match(DAY_RE) || []).length > 1) continue;
    const day = DAYS.indexOf(m[2].toLowerCase());
    const head = chunks(lines[i]);
    // Where the assignments start: the column of "Innlevering torsdag" on the header line.
    const col = head.length > 1 ? head[1].start : 12;
    const subjects = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (DUE.test(l) || (l.match(DAY_RE) || []).length > 2) break; // the next week's plan
      if (repeated.has(l.trim()) || /^\s*ukeplan\b/i.test(l)) continue;
      if (!l.trim()) { if (subjects.length) subjects.at(-1).paras.push(''); continue; }
      const cs = chunks(l);
      if (cs[0].start < col - 2) {
        subjects.push({ name: cs[0].text, paras: [cs.slice(1).map((c) => c.text).join(' ')] });
      } else if (subjects.length) {
        const p = subjects.at(-1).paras;
        p[p.length - 1] = `${p.at(-1)} ${cs.map((c) => c.text).join(' ')}`.trim();
      }
    }
    for (const s of subjects) {
      const paras = s.paras.map(clean).filter(Boolean);
      if (!paras.length) continue;
      // Titled by the first sentence of the first paragraph; all of it in the details.
      let first = (paras[0].match(/^.+?[.!?](?=\s|$)/) || [paras[0]])[0];
      if (first.length > 90) first = `${first.slice(0, 88).replace(/\s+\S*$/, '')}…`;
      out.push({ day: dayOf(day), allDay: true, kind: 'homework', span: 'week', title: clean(`${/lekse/i.test(s.name) ? s.name : `Lekse ${s.name.toLowerCase()}`}: ${first}`), details: paras.join('\n') });
    }
  }
  return out;
}

export function weekPlanEvents(text, { sentAt, title } = {}) {
  const lines = untab(String(text || '').replace(/\r/g, '').split('\n'));
  const monday = planMonday(text, { sentAt, title });
  const dayOf = (i) => ymd(new Date(monday.getTime() + i * 864e5));
  const events = [];
  const seen = new Map();
  for (const l of lines) if (l.trim().length > 15) seen.set(l.trim(), (seen.get(l.trim()) || 0) + 1);
  const repeated = new Set([...seen].filter(([, n]) => n > 1).map(([l]) => l));
  for (const t of tables(lines, repeated)) {
    const rows = cellsOf(t, repeated);
    if (t.homework) {
      // One event per subject and due day, titled by the cell's first two lines (the assignment;
      // what follows is usually the same reminder every day), with the whole cell as details.
      const due = new Map();
      let subject = null;
      for (const r of rows) {
        if (!r) continue;
        if (r.label) subject = r.label;
        for (const [d, txt] of Object.entries(r.cells)) {
          const k = `${d}|${subject}`;
          if (!due.has(k)) due.set(k, { d: Number(d), subject, parts: [] });
          // Wrapped words that land alone between columns ("på", "eller") aren't worth keeping.
          const t2 = txt.split(' ').length === 1 && CONNECTOR.test(txt) ? '' : txt;
          if (t2) due.get(k).parts.push(t2);
        }
      }
      for (const { d, subject: s, parts } of due.values()) {
        if (!parts.length) continue;
        events.push({ day: dayOf(d), allDay: true, kind: 'homework', title: clean(`Lekse${s ? ` ${s.toLowerCase()}` : ''}: ${parts.slice(0, 2).join(' ')}`), details: clean(parts.join(' ')) });
      }
      continue;
    }
    // Text in a column, gathered into runs over consecutive lines (a cell can span time rows),
    // each run with the times of the rows it covers.
    // Some plans (SFO) repeat the week for each group, with the group's label ("1.", "2.") at the
    // side; a row that's routine on (nearly) every day closes a group. What counts as routine is
    // judged within a group, so the gym hall twice a week for each group stays.
    const labels = new Set(rows.filter((r) => r?.label && /^\d\.?$/.test(r.label)).map((r) => r.label));
    let range = null;
    let block = { runs: {}, count: new Map(), group: null };
    const blocks = [block];
    for (const r of rows) {
      if (r?.label && TIME_RANGE.test(r.label)) range = r.label.match(TIME_RANGE).slice(1).map(Number);
      if (r?.label && /^slutter$/i.test(r.label)) {
        for (const [d, txt] of Object.entries(r.cells)) {
          const m = txt.match(TIME);
          if (m) events.push({ day: dayOf(Number(d)), kind: 'ends', title: `Skolen slutter ${m[1]}.${m[2]}`, start: hm(m[1], m[2]), end: hm(m[1], m[2]) });
        }
        for (const list of Object.values(block.runs)) if (list.length) list.at(-1).closed = true;
        continue;
      }
      if (r?.label && /^\d\.?$/.test(r.label)) block.group ||= r.label.replace(/\.$/, '');
      const { runs, count } = block;
      for (let d = 0; d < 5; d++) {
        const txt = r?.cells[d];
        const open = runs[d]?.at(-1);
        if (!txt) { if (open && !r) open.closed = true; continue; }
        const key = clean(txt).toLowerCase();
        count.set(key, (count.get(key) || 0) + 1);
        if (open && !open.closed && !ROUTINE.test(open.text) && !ROUTINE.test(txt)) {
          open.text += ` ${txt}`;
          if (range) open.to = range;
        } else (runs[d] ||= []).push({ text: txt, from: range, to: range });
      }
      if (labels.size > 1 && r && Object.values(r.cells).filter((c) => ROUTINE.test(clean(c))).length >= 4) {
        block = { runs: {}, count: new Map(), group: null };
        blocks.push(block);
      }
    }
    for (const { runs, count, group } of blocks) {
      for (const [d, list] of Object.entries(runs)) {
        for (const x of list) {
          const t2 = clean(x.text);
          // Routine: a known everyday word, or the same text on four or five days.
          // A day with no times (SFO) has short entries; a sentence there is prose from a side column.
          if (!x.from && (/^[a-zæøå]/.test(t2) || (t2.split(' ').length > 6 && !t2.includes(':')))) continue;
          if (ROUTINE.test(t2) || SUBJECT.test(t2) || (count.get(t2.toLowerCase()) || 0) >= 4 || t2.length < 3) continue;
          const ev = { day: dayOf(Number(d)), kind: 'activity', title: t2 };
          if (group) ev.group = group;
          if (x.from) Object.assign(ev, { start: hm(x.from[0], x.from[1]), end: hm(x.to[2], x.to[3]) });
          else ev.allDay = true;
          events.push(ev);
        }
      }
    }
  }
  events.push(...homeworkList(lines, repeated, dayOf));
  return events.sort((a, b) => a.day.localeCompare(b.day) || (a.allDay ? -1 : 1) - (b.allDay ? -1 : 1) || String(a.start).localeCompare(String(b.start)));
}
