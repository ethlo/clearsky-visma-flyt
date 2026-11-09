import { test } from 'node:test';
// Message ids fall back to when it was sent, read in this machine's zone: pin it.
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { client, renew, collectFlyt, waiting, readFlyt, flytFile, parseKey, osloTime, sessionFromCookies, jwtExpiry, keyringStore, fileStore, FlytAuthError, keepAlive } from '../lib/flyt.mjs';
import { browserLogin } from '../lib/flyt-login.mjs';
import { core } from './core.mjs';
import { fileURLToPath } from 'node:url';
const { findBrowser } = await core('lib/browser.mjs');
const { hook } = await core('lib/sources.mjs');
const { sourceFromDir } = await core('lib/plugins.mjs');

const jwt = (expMs) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.s`;
const memStore = (v) => ({ v, where: 'memory', async get() { return this.v; }, async set(x) { this.v = x; } });

// A stand-in for api.foresatt.visma.no with one child, made-up names.
function fakeVisma({ access = jwt(Date.now() + 5 * 60_000) } = {}) {
  const state = { access, renewals: 0, requests: [] };
  const server = createServer((req, res) => {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
    state.requests.push({ url: req.url, cookies, requestedBy: req.headers['requested-by'] });
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (cookies.GwebId !== 'sid') return send(401);
    if (req.url === '/v1/session' && cookies.CookieRefreshToken === 'refresh-1') {
      state.renewals++;
      state.access = jwt(Date.now() + 5 * 60_000);
      res.setHeader('set-cookie', [`CookieAccessToken=${state.access}; path=/; secure; httponly`, 'CookieRefreshToken=refresh-1; path=/; secure; httponly']);
      return send(200, { firstName: 'Kari' });
    }
    if (cookies.CookieAccessToken !== state.access) return send(401);
    const p = '/vfs/v1/pupils/1001';
    const routes = {
      '/v2/children': { children: [{ firstName: 'Ola', school: { pupilId: 1001, organizationName: 'Eksempel skole' } }] },
      [`${p}/messages/direct`]: [
        { employeeId: 7, title: 'Tur fredag', sender: 'Lærer Hansen', messageText: 'Husk matpakke', sentDate: '2026-10-28T08:15:00', unreadCount: 2 },
        { employeeId: 8, title: 'Gammel', sender: 'Rektor', messageText: 'Lest', sentDate: '2026-09-01T08:00:00', unreadCount: 0 },
      ],
      [`${p}/messages/group`]: [{ conversationId: 'c1', title: 'Klasse 3B', lastMessage: { sentBy: 'Kontaktlærer', message: 'Foreldremøte' }, lastMessageDate: '2026-10-27T19:00:00.12', unreadMessageCount: 1 }],
      [`${p}/notifications/0`]: [{ idMessage: 5, title: 'Fravær registrert', sender: 'Skolen', messageText: 'Ola er registrert borte', sentDate: '2026-10-29T09:00:00', isUnread: true,
        attachments: [{ attachmentId: 'n1', fileName: 'Skjema.pdf', contentType: 'application/pdf', contentLength: 4 }] }],
      [`${p}/notifications/1`]: [{ idMessage: 6, title: 'Høstferie', sender: 'Skolen', messageText: '', sentDate: '2026-10-01T09:00:00', isUnread: false }],
      [`${p}/digital-forms`]: [
        { id: 11, title: 'Påmelding skidag', deadline: '2026-11-03T23:59:00', lastModifiedOn: '2026-10-26T10:00:00', isAnswered: false, isDeadlinePassed: false },
        { id: 12, title: 'Utløpt', deadline: '2026-10-01T23:59:00', isAnswered: false, isDeadlinePassed: true },
      ],
    };
    if (req.url === `${p}/consents`) return send(403); // turned off at this school
    if (req.url === '/vfs/v2/pupils/1001/messages/direct/7') return send(200, { canReply: true, messages: [
      { idMessage: 'm2', title: 'Re: Tur fredag', messageText: 'Takk!', sentDate: '2026-10-28T09:00:00', participantType: 2, attachments: [] },
      { idMessage: 'm1', title: 'Tur fredag', messageText: 'Husk matpakke og\nregntøy. Se https://skole.example/tur.', sentDate: '2026-10-28T08:15:00', participantType: 1, attachments: [] },
    ] });
    if (req.url === `${p}/messages/group/c1`) return send(200, { title: 'Klasse 3B', participants: ['Kontaktlærer', 'Kari'], messages: [
      { sentOn: '2026-10-27T19:00:00', sentBy: 'Kontaktlærer', message: 'Foreldremøte tirsdag', sentByMe: false,
        attachments: [{ messageId: 1, attachmentId: 'a1', fileName: 'Innkalling.pdf', contentType: 'application/pdf', contentLength: 4 }] },
      { sentOn: '2026-10-27T18:00:00', sentBy: 'Kontaktlærer', message: 'Hei alle', sentByMe: false, attachments: [] },
    ] });
    if (req.url === `${p}/notifications/attachment/n1`) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-n'); }
    if (req.url === `${p}/messages/group/c1/attachment/a1`) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF'); }
    if (req.url === `${p}/digital-forms/11`) return send(200, { title: 'Påmelding skidag', publishText: 'Bli med?', deadline: '2026-11-03T23:59:00',
      publishedOn: '2026-10-26T10:00:00', lastModifiedBy: 'Rektor', alternatives: [{ id: 2, order: 2, text: 'Nei' }, { id: 1, order: 1, text: 'Ja' }], attachments: [] });
    if (routes[req.url]) return send(200, routes[req.url]);
    send(404, { message: 'Not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ api: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() })));
}

test('Oslo times without a zone become UTC, summer and winter', () => {
  assert.equal(osloTime('2026-07-01T12:00:00'), '2026-07-01T10:00:00.000Z');
  assert.equal(osloTime('2026-12-01T12:00:00.5'), '2026-12-01T11:00:00.500Z');
  assert.equal(osloTime('2026-10-12T20:05:58.123'), '2026-10-12T18:05:58.123Z');
  assert.equal(osloTime('2026-10-12T10:00:00Z'), '2026-10-12T10:00:00.000Z');
  assert.equal(osloTime(null), null);
});

test('a login needs all three cookies, for the API host only', () => {
  const host = 'api.foresatt.visma.no';
  const all = [{ name: 'CookieAccessToken', value: jwt(Date.UTC(2026, 9, 29)), domain: host },
    { name: 'CookieRefreshToken', value: 'r', domain: host }, { name: 'GwebId', value: 'g', domain: `.${host}` },
    { name: 'CookieCustomerKey', value: 'eksempel', domain: host }];
  const s = sessionFromCookies(all);
  assert.equal(s.refresh, 'r');
  assert.equal(s.session, 'g');
  assert.equal(s.customerKey, 'eksempel');
  assert.equal(s.expires, '2026-10-29T00:00:00.000Z');
  assert.equal(sessionFromCookies(all.slice(0, 2)), null);
  assert.equal(sessionFromCookies(all.map((c) => ({ ...c, domain: 'evil.example' }))), null);
  assert.equal(jwtExpiry('not a jwt'), null);
});

test('renewal sends only the session id and the refresh token', async () => {
  const v = await fakeVisma();
  try {
    const s = await renew({ session: 'sid', refresh: 'refresh-1', access: 'old' }, { api: v.api });
    assert.equal(s.access, v.state.access);
    assert.ok(Date.parse(s.expires) > Date.now());
    assert.deepEqual(Object.keys(v.state.requests[0].cookies).sort(), ['CookieRefreshToken', 'GwebId']);
    assert.equal(v.state.requests[0].requestedBy, 'XMLHttpRequest');
    await assert.rejects(renew({ session: 'sid', refresh: 'wrong' }, { api: v.api }), FlytAuthError);
  } finally { v.close(); }
});

test('an access token about to run out is renewed once, saved, and shared by parallel calls', async () => {
  const v = await fakeVisma();
  try {
    const store = memStore({ session: 'sid', refresh: 'refresh-1', access: 'stale', expires: new Date(Date.now() + 10_000).toISOString() });
    const c = client({ store, api: v.api });
    await Promise.all([c.get('v2/children'), c.get('v2/children'), c.get('v2/children')]);
    assert.equal(v.state.renewals, 1);
    assert.equal(store.v.access, v.state.access, 'the renewed login is kept');
  } finally { v.close(); }
});

test('a 401 mid-run renews and retries; a dead login asks you to log in again', async () => {
  const v = await fakeVisma();
  try {
    const store = memStore({ session: 'sid', refresh: 'refresh-1', access: 'revoked', expires: new Date(Date.now() + 3e5).toISOString() });
    assert.ok((await client({ store, api: v.api }).get('v2/children')).children);
    assert.equal(v.state.renewals, 1);
    const dead = memStore({ session: 'sid', refresh: 'expired', access: 'x', expires: new Date(Date.now() + 3e5).toISOString() });
    await assert.rejects(client({ store: dead, api: v.api }).get('v2/children'), (e) => e.auth && /Log in to Visma Flyt Skole again/.test(e.message));
    assert.ok(dead.v.expiredAt, 'a dead login is remembered');
    const sent = v.state.requests.length;
    await assert.rejects(client({ store: dead, api: v.api }).get('v2/children'), (e) => e.auth);
    assert.equal(v.state.requests.length, sent, 'and not tried again until you log in');
    await assert.rejects(client({ store: memStore(null), api: v.api }).get('v2/children'), /Not logged in/);
  } finally { v.close(); }
});

test('collects what waits for each child; areas a school has turned off come back empty', async () => {
  const v = await fakeVisma();
  try {
    const store = memStore({ session: 'sid', refresh: 'refresh-1', customerKey: 'eksempel' });
    const data = await collectFlyt({ store, api: v.api });
    assert.equal(data.customerKey, 'eksempel');
    const [ola] = data.children;
    assert.equal(ola.name, 'Ola');
    assert.equal(ola.threads.length, 3);
    assert.deepEqual(ola.consents, []);
    assert.ok(v.state.requests.every((r) => !r.url.includes('mark-as-read') && !r.url.includes('reply')));

    const w = waiting(data);
    assert.deepEqual(w.map((x) => x.key), ['flyt:notice:1001:5', 'flyt:direct:1001:7', 'flyt:group:1001:c1', 'flyt:form:1001:11']);
    assert.equal(w[1].at, '2026-10-28T07:15:00.000Z');
    assert.equal(w[1].count, 2);
    assert.equal(w[3].deadline, '2026-11-03T22:59:00.000Z');
  } finally { v.close(); }
});

test('the source module fits the contract and turns data into rows, notifications and deadlines', async () => {
  const s = await sourceFromDir(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(s.panel.zone, 'needs');
  assert.equal(s.enabled({}), false);
  assert.equal(s.enabled({ FLYT_SCHOOL_KEY: 'eksempel' }), true);
  const v = await fakeVisma();
  try {
    const now = () => Date.parse('2026-10-29T12:00:00Z');
    const data = { ...await collectFlyt({ store: memStore({ session: 'sid', refresh: 'refresh-1' }), api: v.api, now }), customerKey: 'eksempel' };
    // A second child who got the same announcement: it shows once, under School.
    const ola = data.children[0];
    data.children.push({ ...ola, name: 'Kari', pupilId: 1002, threads: [], forms: [], consents: [],
      notices: ola.notices.filter((n) => n.kind === 'announcement').map((n) => ({ ...n, id: n.id.replace(':1001:', ':1002:') })) });
    assert.equal(s.panel.view, 'table');
    const items = hook(s, 'items', data);
    assert.deepEqual(items.map((i) => [i.key, i.group, i.unread, i.files]), [
      ['flyt:notice:1001:5', 'Ola', true, 1],
      ['flyt:direct:1001:7:m1', 'Ola', true, 0],
      ['flyt:group:1001:c1:1793127600000', 'Ola', true, 1],
      ['flyt:group:1001:c1:1793124000000', 'Ola', false, 0],
      ['flyt:form:1001:11', 'Ola', true, null],
      ['flyt:notice:1001:6', 'School', false, 0],
      ['flyt:direct:1001:8', 'Ola', false, null],
    ]);
    assert.equal(items[0].url, 'https://foresatt.visma.no/eksempel');
    assert.deepEqual([items[1].from, items[1].at, items[1].detail], ['Lærer Hansen', '2026-10-28T07:15:00.000Z', true]);
    assert.equal(items[4].tone, 'amber');
    assert.equal(items[4].meta, 'Answer by 2026-11-03');
    // Each message of a group thread is a row, named by its group.
    assert.deepEqual([items[2].from, items[2].meta, items[3].quote], ['Kontaktlærer', 'in Klasse 3B', 'Hei alle']);
    // Reading it at school changes the stamp, so a hidden row would show again as read.
    assert.notEqual(items[0].stamp, hook(s, 'items', { ...data, children: data.children.map((k) => ({ ...k, notices: k.notices.map((n) => ({ ...n, unread: false })) })) })[0].stamp);
    const notes = hook(s, 'attention', data);
    assert.equal(notes[0].title, 'Ola: Fravær registrert');
    const events = hook(s, 'events', data);
    assert.deepEqual(events.map((e) => [e.uid, e.fyi]), [['flyt:form:1001:11', true]]);
    // A new message on a thread changes its notification stamp, so it notifies again.
    assert.notEqual(waiting(data).find((w) => w.key === 'flyt:direct:1001:7').stamp, waiting({ children: [{ ...data.children[0], threads: data.children[0].threads.map((t) => ({ ...t, unread: t.unread + 1 })), notices: [], forms: [], consents: [] }] })[0].stamp);
  } finally { v.close(); }
});

test('the login is kept in the keyring through secret-tool, or in a private file', async () => {
  const calls = [];
  const ring = keyringStore({ tool: async (args, input) => { calls.push({ args, input }); return args[0] === 'lookup' ? calls.find((c) => c.args[0] === 'store')?.input || '' : ''; } });
  assert.equal(await ring.get(), null);
  const empty = keyringStore({ tool: async () => { throw Object.assign(new Error('exit 1'), { code: 1 }); } });
  assert.equal(await empty.get(), null, 'nothing stored yet is not an error');
  const none = keyringStore({ tool: async () => { throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }); } });
  await assert.rejects(none.get(), /ENOENT/);
  await ring.set({ refresh: 'r' });
  assert.deepEqual(await ring.get(), { refresh: 'r' });
  assert.ok(calls.every((c) => !c.args.join(' ').includes('"refresh"')), 'the secret goes on stdin, never on the command line');

  const file = join(mkdtempSync(join(tmpdir(), 'clearsky-flyt-')), 'sub', 'flyt-session.json');
  const fs = fileStore(file);
  await fs.set({ refresh: 'r' });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(await fs.get(), { refresh: 'r' });
  await fs.clear();
  assert.equal(existsSync(file), false);
});

test('reads a whole thread, notice or form, oldest first, without marking anything read', async () => {
  const v = await fakeVisma();
  try {
    const store = memStore({ session: 'sid', refresh: 'refresh-1' });
    const data = await collectFlyt({ store, api: v.api });
    const direct = await readFlyt('flyt:direct:1001:7', data, { store, api: v.api });
    assert.equal(direct.child, 'Ola');
    assert.deepEqual(direct.messages.map((m) => [m.from, m.mine, m.text.split('\n')[0]]), [['Lærer Hansen', false, 'Husk matpakke og'], ['You', true, 'Takk!']]);

    // One message of it, as its row opens it: only that message.
    const one = await readFlyt('flyt:group:1001:c1:1793124000000', data, { store, api: v.api });
    assert.deepEqual([one.meta, one.messages.map((m) => m.text)], ['Klasse 3B', ['Hei alle']]);
    const group = await readFlyt('flyt:group:1001:c1', data, { store, api: v.api });
    assert.equal(group.meta, 'Kontaktlærer, Kari');
    assert.deepEqual(group.messages.map((m) => m.text), ['Hei alle', 'Foreldremøte tirsdag']);
    assert.deepEqual(group.messages[1].attachments, [{ id: 'a1', name: 'Innkalling.pdf', type: 'application/pdf', bytes: 4 }]);

    const notice = await readFlyt('flyt:notice:1001:5', data, { store, api: v.api });
    assert.equal(notice.messages[0].text, 'Ola er registrert borte');

    const form = await readFlyt('flyt:form:1001:11', data, { store, api: v.api });
    assert.match(form.messages[0].text, /Bli med\?\n\nChoices:\n• Ja\n• Nei/);

    const file = await flytFile('flyt:group:1001:c1', 'a1', data, { store, api: v.api });
    assert.deepEqual([file.name, file.type, file.data.toString()], ['Innkalling.pdf', 'application/pdf', '%PDF']);
    const noticeFile = await flytFile('flyt:notice:1001:5', 'n1', data, { store, api: v.api });
    assert.deepEqual([noticeFile.name, noticeFile.data.toString()], ['Skjema.pdf', '%PDF-n']);
    assert.deepEqual(notice.messages[0].attachments.map((a) => a.name), ['Skjema.pdf']);
    await assert.rejects(flytFile('flyt:group:1001:c1', 'not-in-this-thread', data, { store, api: v.api }), /No such attachment/);
    assert.ok(v.state.requests.every((r) => !/mark-as-read|reply/.test(r.url)));
  } finally { v.close(); }
});

test('only plain ids from a key go into an API path', () => {
  assert.deepEqual(parseKey('flyt:group:1001:c1'), { kind: 'group', pupil: '1001', id: 'c1' });
  assert.deepEqual(parseKey('flyt:group:1001:c1:m9'), { kind: 'group', pupil: '1001', id: 'c1', message: 'm9' });
  assert.throws(() => parseKey('flyt:form:1001:11:2'), /Not a Visma/);
  for (const bad of ['flyt:group:1001:../../v1/session', 'flyt:direct:7', 'flyt:other:1:2', 'flyt:form:1001:1?x=1']) assert.throws(() => parseKey(bad), /Not a Visma/);
});

// Runs only where a Chromium is at hand: CLEARSKY_TEST_BROWSER, or one on the PATH.
const testBrowser = process.env.CLEARSKY_TEST_BROWSER || findBrowser();
test('the browser login waits for the portal to set its cookies, then closes the window', { skip: !testBrowser && 'no Chromium here' }, async () => {
  // A page that "logs in" a moment after it opens, like the ID-porten round trip.
  const portal = createServer((req, res) => {
    if (req.url === '/callback') {
      res.setHeader('set-cookie', [`CookieAccessToken=${jwt(Date.now() + 3e5)}; Path=/`, 'CookieRefreshToken=refresh-1; Path=/', 'GwebId=sid; Path=/']);
      return res.end('<p>Logged in</p>');
    }
    res.setHeader('content-type', 'text/html');
    res.end('<p>Log in</p><script>setTimeout(() => location.href = "/callback", 1500)</script>');
  });
  await new Promise((r) => portal.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${portal.address().port}`;
  try {
    const s = await browserLogin({ browser: testBrowser, url: `${base}/eksempel`, api: base, timeoutMs: 30_000, extraArgs: ['--headless=new', '--no-sandbox'] });
    assert.equal(s.session, 'sid');
    assert.equal(s.refresh, 'refresh-1');
    assert.ok(Date.parse(s.expires) > Date.now());
  } finally { portal.close(); }
});

test('a school login handed over in the file moves into the container keyring, once', async () => {
  const { defaultStore, handOverLogin } = await import('../lib/flyt.mjs');
  const mem = (v = null) => ({ v, where: 'mem', async get() { return this.v; }, async set(x) { this.v = x; }, async clear() { this.v = null; } });
  const hostRing = mem({ access: 'a' }), file = mem();
  assert.equal(await handOverLogin({ ring: hostRing, file }), 'mem');
  assert.deepEqual([hostRing.v, file.v], [null, { access: 'a' }]);
  const ring = mem();
  assert.equal(await defaultStore({ ring, file }), ring);
  assert.deepEqual([ring.v, file.v], [{ access: 'a' }, null]);
  // No keyring at all: the file it is.
  const broken = { async get() { throw new Error('no secret-tool'); } };
  assert.equal(await defaultStore({ ring: broken, file }), file);
});

test('keep-alive renews a login that is due, and leaves a lost one alone', async () => {
  const v = await fakeVisma();
  try {
    const store = memStore({ session: 'sid', refresh: 'refresh-1', access: 'old', expires: new Date(Date.now() - 1000).toISOString() });
    assert.equal(await keepAlive({ store, api: v.api }), 'renewed');
    assert.equal(v.state.renewals, 1);
    assert.deepEqual(v.state.requests.map((r) => r.url), ['/v1/session', '/v2/children'], 'only the children list: nothing marked read');
    const lost = memStore({ session: 'sid', refresh: 'refresh-1', expiredAt: '2026-11-01T00:00:00Z' });
    assert.equal(await keepAlive({ store: lost, api: v.api }), 'not logged in');
    assert.equal(await keepAlive({ store: memStore(null), api: v.api }), 'not logged in');
    assert.equal(v.state.requests.length, 2, 'no requests without a login');
  } finally { v.close(); }
});
