// A tiny headless-browser driver for the page tests: starts Chrome or Edge with a temporary profile (no window is ever shown),
// talks to it over the DevTools protocol, and collects everything the page logs or requests.
// Needs a browser on the machine and a Node with a global WebSocket (22+); otherwise `findBrowser()` returns null and the tests skip.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTmp } from './index.mjs';

export function findBrowser(env = process.env) {
  if (typeof WebSocket === 'undefined') return null;
  const candidates = [];
  if (env.LDV_BROWSER) candidates.push(env.LDV_BROWSER);
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const directory of (env.PATH ?? '').split(path.delimiter)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) candidates.push(path.join(directory, name));
    }
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Page {
  static async open(browserPath, { width = 1400, height = 900 } = {}) {
    const profile = makeTmp('ldv-browser-');
    // On Windows the program that is started may hand over to another process and exit at once, so the process is not
    // watched: the browser writes its DevTools port into the profile folder, and `close()` shuts it down through the protocol.
    const child = spawn(
      browserPath,
      ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
      { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' },
    );
    child.unref();
    let endpoint = null;
    const deadline = Date.now() + 30_000;
    while (endpoint === null && Date.now() < deadline) {
      try {
        const [port, socketPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
        if (port && socketPath) endpoint = `ws://127.0.0.1:${port.trim()}${socketPath.trim()}`;
      } catch {
        /* not written yet */
      }
      if (endpoint === null) await sleep(100);
    }
    if (endpoint === null) throw new Error('the browser did not start (no DevToolsActivePort file)');
    const page = new Page(child, endpoint);
    await page.connect();
    const { targetId } = await page.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await page.send('Target.attachToTarget', { targetId, flatten: true });
    page.session = sessionId;
    for (const method of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await page.send(method, {}, sessionId);
    await page.resize(width, height);
    return page;
  }

  constructor(child, endpoint) {
    this.child = child;
    this.endpoint = endpoint;
    this.nextId = 0;
    this.pending = new Map();
    this.errors = [];
    this.requests = [];
    this.session = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.endpoint);
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', () => reject(new Error('cannot connect to the browser')));
      this.ws.addEventListener('message', (event) => this.onMessage(JSON.parse(String(event.data))));
    });
  }

  onMessage(message) {
    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
      return;
    }
    const { method, params } = message;
    if (method === 'Runtime.exceptionThrown') this.errors.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
    else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') this.errors.push(`console.error: ${params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
    else if (method === 'Log.entryAdded' && params.entry.level === 'error' && !/favicon/.test(params.entry.url ?? params.entry.text)) this.errors.push(`log: ${params.entry.text} ${params.entry.url ?? ''}`);
    else if (method === 'Network.requestWillBeSent') this.requests.push(params.request.url);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = (this.nextId += 1);
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  call(method, params) {
    return this.send(method, params, this.session);
  }

  async resize(width, height) {
    await this.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async colorScheme(value) {
    await this.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  }

  async goto(file, hash = '') {
    this.errors.length = 0;
    this.requests.length = 0;
    await this.call('Page.navigate', { url: pathToFileURL(file).href + hash });
    await this.waitFor('document.readyState === "complete" && !!window.LDV_MANIFEST');
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`in the page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  }

  async waitFor(expression, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for: ${expression} (last: ${String(last).slice(0, 200)})`);
  }

  async mouse(type, x, y) {
    await this.call('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  }

  async hover(x, y) {
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  }

  async drag(fromX, fromY, toX, toY) {
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY, button: 'none' });
    await this.mouse('mousePressed', fromX, fromY);
    const steps = 5;
    for (let i = 1; i <= steps; i += 1) await this.mouse('mouseMoved', fromX + ((toX - fromX) * i) / steps, fromY + ((toY - fromY) * i) / steps);
    await this.mouse('mouseReleased', toX, toY);
  }

  async key(key, code, virtualCode) {
    for (const type of ['keyDown', 'keyUp']) await this.call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtualCode });
  }

  async close() {
    try {
      await this.send('Browser.close');
    } catch {
      /* the browser is going away */
    }
    this.ws.close();
    this.child.kill();
  }
}
