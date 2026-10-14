// Minimal HTTP router and helpers on node:http (no framework dependency).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { SessionUser, Permission } from '../src/api/types';
import { AppError } from './db/repo';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  user: SessionUser | null;
  sessionId: string | null;
  ip: string;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; auth: boolean; perm?: Permission }

export class Router {
  private routes: Route[] = [];
  constructor(private authenticate: (req: IncomingMessage, url: URL) => Promise<{ user: SessionUser; sessionId: string } | null>) {}

  add(method: string, path: string, handler: Handler, opts: { auth?: boolean; perm?: Permission } = {}): void {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler, auth: opts.auth ?? true, perm: opts.perm });
  }

  async handle(req: IncomingMessage, res: ServerResponse, staticDir: string): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = req.socket.remoteAddress ?? '';
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res, staticDir);
    const route = this.routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return send(res, 404, { error: 'Not found' });
    const m = route.re.exec(url.pathname)!;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      const ctx: Ctx = { req, res, params, query: url.searchParams, body: null, user: null, sessionId: null, ip };
      if (route.auth) {
        const a = await this.authenticate(req, url);
        if (!a) return send(res, 401, { error: 'Please sign in' });
        ctx.user = a.user;
        ctx.sessionId = a.sessionId;
        if (route.perm && !a.user.permissions.includes(route.perm)) {
          return send(res, 403, { error: `Your role (${a.user.roleName}) does not have the ${route.perm} permission` });
        }
      }
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') ctx.body = await readJson(req);
      const out = await route.handler(ctx);
      if (!res.headersSent && !res.writableEnded) send(res, 200, out ?? { ok: true });
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof AppError) return send(res, e.status, { error: e.message });
      console.error('[api]', req.method, url.pathname, e);
      send(res, 500, { error: 'Server error — see the server log' });
    }
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new AppError(413, 'Request too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'Invalid JSON body'); }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};

function serveStatic(pathname: string, res: ServerResponse, dir: string): void {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(dir, safe);
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Frontend not built. Run `npm run build`, or use `npm run dev` for development.');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- validation helpers
export function str(v: unknown, name: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw new AppError(400, `${name} is required`);
  }
  if (typeof v !== 'string') throw new AppError(400, `${name} must be text`);
  const s = v.trim();
  if (opts.min && s.length < opts.min) throw new AppError(400, `${name} must be at least ${opts.min} characters`);
  if (opts.max && s.length > opts.max) throw new AppError(400, `${name} must be at most ${opts.max} characters`);
  return s;
}

export function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new AppError(400, `${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

export function int(v: unknown, name: string, opts: { optional?: boolean; min?: number; max?: number } = {}): number | null {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return null;
    throw new AppError(400, `${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new AppError(400, `${name} must be a whole number`);
  if (opts.min !== undefined && n < opts.min) throw new AppError(400, `${name} must be ≥ ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new AppError(400, `${name} must be ≤ ${opts.max}`);
  return n;
}
