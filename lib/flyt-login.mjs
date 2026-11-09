// Log in to Visma Flyt Skole with ID-porten (BankID, MinID) in a real browser window, and
// keep the login. Opens your default Chrome-type browser with a fresh, throw-away profile and the DevTools
// port on, waits until the portal has set its login cookies, then reads them and closes the
// window. Uses Node's built-in WebSocket, so nothing to install.

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { API, PORTAL, sessionFromCookies, renew, defaultStore } from './flyt.mjs';

// The browser comes from Clearsky (what it lends plugins that run inside it; see lib/plugins.mjs).
let lent = null;
export const useBrowserFrom = (lends) => { lent = lends; };
const findBrowser = () => {
  if (!lent?.findBrowser) throw new Error('no browser to log in with: Clearsky lends one to plugins that run inside it');
  return lent.findBrowser();
};

// A tiny DevTools client: send a command, get its result.
async function devtools(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not reach the browser')); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
  };
  ws.onclose = () => { for (const w of waiting.values()) w.reject(new Error('the browser window was closed')); waiting.clear(); };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error('the browser window was closed'));
      waiting.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

// Opens the login and resolves with the login once the portal has set its cookies.
export async function browserLogin({ schoolKey, browser = findBrowser(), url, api = API, timeoutMs = 10 * 60_000, extraArgs = [] } = {}) {
  if (!browser) throw new Error('No Chrome or Chromium found. Install one, or set CLEARSKY_BROWSER to its path.');
  const start = url || (schoolKey ? `${PORTAL}/${encodeURIComponent(schoolKey)}` : PORTAL);
  const profile = mkdtempSync(join(tmpdir(), 'clearsky-flyt-'));
  const proc = spawn(browser, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', ...extraArgs, start], { stdio: 'ignore' });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  proc.on('error', () => { exited = true; });
  let dt;
  try {
    const deadline = Date.now() + timeoutMs;
    const portFile = join(profile, 'DevToolsActivePort');
    while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
      if (exited) throw new Error(`${browser} did not start`);
      if (Date.now() > deadline) throw new Error('the browser did not start in time');
      await sleep(200);
    }
    const [port, path] = readFileSync(portFile, 'utf8').split('\n');
    dt = await devtools(`ws://127.0.0.1:${port.trim()}${path.trim()}`);
    const host = new URL(api).hostname;
    while (Date.now() < deadline) {
      const { cookies } = await dt.send('Storage.getCookies');
      const session = sessionFromCookies(cookies, host);
      if (session) return session;
      await sleep(1000);
    }
    throw new Error('Gave up waiting for the login after 10 minutes');
  } finally {
    await dt?.send('Browser.close').catch(() => {});
    dt?.close();
    if (!exited) proc.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

// Log in, check the login renews, and keep it.
export async function login({ schoolKey, store, api = API, fetch = globalThis.fetch, ...opts } = {}) {
  store ??= await defaultStore();
  const fromBrowser = await browserLogin({ schoolKey, api, ...opts });
  // Renewing straight away proves Clearsky can keep the login alive on its own.
  const session = await renew({ ...fromBrowser, customerKey: fromBrowser.customerKey || schoolKey || null }, { api, fetch });
  await store.set(session);
  return { where: store.where, customerKey: session.customerKey };
}

