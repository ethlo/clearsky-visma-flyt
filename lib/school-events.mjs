// The school's weekly plans as a calendar of their own: the PDF and Word files on recent
// messages from school are read (by script, see weekplan.mjs), and what's on each day becomes
// an event on a virtual "School" calendar in Clearsky. Nothing is written to Google.
//
// Each file is read once: what came out of it (also nothing, for a file that isn't a plan) is
// kept in ~/.config/clearsky/school-events.json, readable only by you.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { documentText } from './doctext.mjs';
import { weekPlanEvents, VERSION } from './weekplan.mjs';

export const CACHE = join(homedir(), '.config', 'clearsky', 'school-events.json');
const DOC = /\.(pdf|docx)$/i;
const DOC_TYPE = /pdf|wordprocessingml/i;
const isDoc = (a) => DOC.test(a.name || '') || DOC_TYPE.test(a.type || '');
// Only what looks like a plan is fetched: not minutes, class lists and the like.
const PLAN = /\b(uke|ukeplan|plan|week|sfo)/i;

function load(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}
function save(file, cache) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cache), { mode: 0o600 });
}

// Wall-clock time on a day, in the server's time zone (yours), as an ISO string.
const at = (day, hm = '00:00') => new Date(`${day}T${hm}:00`).toISOString();
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

// messages: [{ key, title, at, docs: [{ id, name, type }] }], newest first.
// readFile(key, id) → { data: Buffer, type, name }.
// Returns events for Now / Next: { uid, title, start, end, allDay, fyi, description, read }.
export async function schoolEvents(messages, { readFile, file = CACHE, days = 21, maxNew = 8, now = Date.now(), log = () => {} } = {}) {
  const since = new Date(now - days * 864e5).toISOString();
  const cache = load(file);
  const keep = {};
  let fresh = 0, changed = false;
  const out = [];
  for (const m of messages) {
    if (!m.at || m.at < since) continue;
    for (const doc of (m.docs || []).filter((d) => isDoc(d) && (PLAN.test(d.name || '') || PLAN.test(m.title || '')))) {
      const id = `${m.key}|${doc.id}`;
      let hit = cache[id]?.v === VERSION ? cache[id] : null;
      if (!hit && fresh < maxNew) {
        fresh++;
        changed = true;
        try {
          const f = await readFile(m.key, doc.id);
          const text = await documentText(f.data, { name: doc.name, type: f.type || doc.type });
          const title = `${m.title || ''} ${doc.name || ''}`;
          // Whose plan it is, for when there's more than one child: SFO, or the class ("3. trinn").
          const who = /\bSFO\b/.test(title) ? 'SFO' : (`${title}\n${text}`.match(/\b(\d{1,2})\.\s*trinn\b/i) || [])[1];
          hit = { v: VERSION, who: who && (who === 'SFO' ? who : `${who}. trinn`), events: weekPlanEvents(text, { sentAt: m.at, title }) };
        } catch (e) {
          log(`school plan ${doc.name}: ${e.message}`);
          hit = { v: VERSION, events: [], error: e.message, at: new Date(now).toISOString() };
        }
      }
      if (!hit) continue;
      // A file that failed (the portal often answers 500 for a while) is tried again after half an hour.
      if (hit.error && Date.parse(hit.at) < now - 30 * 6e4) { changed = true; continue; }
      keep[id] = { ...hit, sent: m.at };
      for (const e of hit.events) out.push({ ...e, key: m.key, file: doc.name, sent: m.title, who: hit.who });
    }
  }
  // Files no longer in the list are kept a while: a fetch that comes back short (the portal
  // having a bad minute) mustn't mean reading every plan again.
  for (const [id, hit] of Object.entries(cache)) if (!keep[id] && hit.v === VERSION && Date.parse(hit.sent) > now - 3 * days * 864e5) keep[id] = hit;
  if (changed || Object.keys(keep).length !== Object.keys(cache).length) save(file, keep);
  // A plan sent again (corrected, or in two messages) gives the same events once.
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.who}|${e.day}|${e.start || ''}|${e.title.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((e, i) => {
    const title = `${e.who ? `${e.who}: ` : ''}${e.title}${e.group ? ` (gruppe ${e.group})` : ''}`;
    const timed = e.start && !e.allDay;
    // When school ends is a moment; a quarter of an hour shows it in the day.
    const end = e.kind === 'ends' ? new Date(Date.parse(at(e.day, e.start)) + 15 * 6e4).toISOString() : timed && at(e.day, e.end);
    return {
      uid: `school:${e.key}:${e.day}:${i}`,
      title,
      start: timed ? at(e.day, e.start) : at(e.day),
      end: timed ? end : at(nextDay(e.day)),
      allDay: !timed,
      fyi: true,
      kind: e.kind,
      ...(e.span && { span: e.span }),
      // For the School week view: whose plan, and the title without it.
      who: e.who || null,
      what: `${e.title}${e.group ? ` (gruppe ${e.group})` : ''}`,
      description: [e.details, `From ${e.file}${e.sent ? `, in "${e.sent}"` : ''}.`].filter(Boolean).join('\n'),
      read: { src: 'flyt', key: e.key },
    };
  });
}
