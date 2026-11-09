// School: what Visma Flyt Skole (Min Skole / Flyt Foresatt) has for your children. Log in once
// with BankID from Settings; the login is kept in the GNOME keyring. What it reaches and keeps
// is in clearsky-plugin.json; this is what it does.

import { collectFlyt, waiting, inbox, portalUrl, defaultStore, readFlyt, flytFile, keepAlive } from './lib/flyt.mjs';
import { login, useBrowserFrom } from './lib/flyt-login.mjs';
import { schoolEvents, CACHE } from './lib/school-events.mjs';

const WHAT = { message: 'Message', notice: 'Notice', announcement: 'Announcement', form: 'Form to answer', consent: 'Consent to answer' };

export default (lends) => (useBrowserFrom(lends), {
  login: {
    label: 'Log in with BankID',
    async status() {
      const s = await (await defaultStore()).get();
      if (!s) return { loggedIn: false, detail: 'Opens a browser window for ID-porten (BankID or MinID).' };
      if (s.expiredAt) return { loggedIn: false, detail: 'Visma ended the login. Log in again.' };
      return { loggedIn: true, detail: `Since ${new Date(s.loggedInAt).toLocaleString('nb-NO', { dateStyle: 'medium', timeStyle: 'short' })}` };
    },
    async start(env) {
      const { customerKey } = await login({ schoolKey: env.FLYT_SCHOOL_KEY });
      return { settings: { FLYT_SCHOOL_KEY: env.FLYT_SCHOOL_KEY || customerKey } };
    },
  },
  async fetch(ctx) {
    const data = await collectFlyt();
    const out = { ...data, customerKey: data.customerKey || ctx.env.FLYT_SCHOOL_KEY };
    if (/^(off|no|false|0)$/i.test(ctx.env.FLYT_EVENTS || '')) return out;
    // The weekly plans: a problem with them shouldn't hide the messages.
    try {
      out.planEvents = (await schoolEvents(inbox(out), { readFile: (key, id) => flytFile(key, id, out), file: CACHE, log: (m) => console.error(m) }))
        .map((e) => ({ ...e, calendar: ctx.env.FLYT_CALENDAR || 'School' }));
    } catch (e) { out.planError = e.message; }
    return out;
  },

  items: (d) => inbox(d).map((m) => ({
    key: m.key, stamp: m.stamp, url: portalUrl(d.customerKey), detail: true,
    title: m.title, quote: m.body, at: m.at, from: m.from || 'The school', group: m.group, files: m.files, unread: m.unread,
    badge: WHAT[m.what], tone: m.unread && (m.what === 'form' || m.what === 'consent') ? 'amber' : undefined,
    meta: m.deadline ? `Answer by ${m.deadline.slice(0, 10)}` : m.thread ? `in ${m.thread}` : undefined,
  })),

  // Every 30 minutes to 2 hours, at random, while Clearsky runs, so the login doesn't lapse.
  keepAlive: () => keepAlive(),

  // The whole message, notice or form, and its files, read inside Clearsky.
  detail: (key, ctx, data) => readFlyt(key, data),
  attachment: (key, id, ctx, data) => flytFile(key, id, data),

  attention: (d) => waiting(d).map((w) => ({
    key: w.key, stamp: w.stamp, at: w.at, url: portalUrl(d.customerKey),
    title: `${w.child}: ${w.title || WHAT[w.what]}`, body: w.body || WHAT[w.what],
  })),

  // Deadlines on forms you haven't answered, as reminders that don't block time, and what the
  // weekly plans say is on each day.
  events: (d) => [
    ...waiting(d).filter((w) => w.deadline).map((w) => ({
      uid: w.key, title: `${w.child}: answer "${w.title}"`, start: w.deadline, end: w.deadline, allDay: false, fyi: true,
    })),
    ...(d.planEvents || []),
  ],
});
