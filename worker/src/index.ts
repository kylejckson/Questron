// worker/src/index.ts
// Cloudflare Worker entry — routes HTTP + WebSocket connections to GameRoom DOs.

import { GameRoom, Env } from './GameRoom';
export { GameRoom };

// ── ID generation ─────────────────────────────────────────────────────────
// 6 chars from unambiguous alphabet (no 0/O/1/I/L) → 30^6 ≈ 729M combinations
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateGameId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// ── Quiz validation ───────────────────────────────────────────────────────

function validateQuiz(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as any;
  if (!Array.isArray(p.questions) || p.questions.length === 0) return false;
  if (p.questions.length > 50) return false; // max 50 questions
  if (typeof p.title !== 'string' || !p.title.trim()) return false;
  // Validate imageRef paths: must be a simple filename, no path traversal
  const safeFilename = /^[\w.\-]{1,100}$/;
  for (const q of p.questions) {
    if (!q || typeof q !== 'object') return false;
    if (typeof q.id !== 'string' || !q.id.trim()) return false;
    if (typeof q.text !== 'string' || !q.text.trim()) return false;
    if (!Array.isArray(q.options) || q.options.length < 2) return false;
    for (const opt of q.options) {
      if (!opt || typeof opt !== 'object') return false;
      if (typeof opt.id !== 'string' || !opt.id.trim()) return false;
      if (typeof opt.label !== 'string' || !opt.label.trim()) return false;
    }
    if (!Array.isArray(q.correctOptionIds) || q.correctOptionIds.length === 0) return false;
    // imageRef must be a safe plain filename (no path separators, no traversal)
    if (q.imageRef !== undefined && q.imageRef !== null) {
      if (typeof q.imageRef !== 'string' || !safeFilename.test(q.imageRef)) return false;
    }
  }
  return true;
}

// ── Origin / CORS ─────────────────────────────────────────────────────────

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (origin === 'https://questron.app' || origin === 'https://www.questron.app') return true;
  if (origin === 'https://questron.pages.dev') return true;
  // Allow Cloudflare Pages preview deployments (*.questron.pages.dev)
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith('.questron.pages.dev')) return true;
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:';
  } catch { return false; }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = isOriginAllowed(origin) ? origin! : 'https://questron.app';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function corsJson(data: unknown, origin: string | null, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders(origin) });
}

// ── Rate Limiting (per-isolate; resets on isolate recycle) ────────────────

const rateBuckets = new Map<string, number[]>();
const RATE_WINDOW_MS = 10_000;

function isRateLimited(ip: string, max: number): boolean {
  const now = Date.now();
  let hits = rateBuckets.get(ip);
  if (!hits) { hits = []; rateBuckets.set(ip, hits); }
  while (hits.length > 0 && hits[0]! < now - RATE_WINDOW_MS) hits.shift();
  hits.push(now);
  // Prevent unbounded memory growth across many unique IPs
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) {
      if (v.length === 0 || v[v.length - 1]! < now - RATE_WINDOW_MS * 2) rateBuckets.delete(k);
    }
  }
  return hits.length > max;
}

// ── Worker ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin');
    const ip     = request.headers.get('CF-Connecting-IP') || 'unknown';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // ── POST /api/create ── create a new game room ────────────────────
    if (url.pathname === '/api/create' && request.method === 'POST') {
      if (isRateLimited(ip, 10)) return corsJson({ ok: false, error: 'Too many requests.' }, origin, 429);

      let quiz: unknown;
      try { quiz = await request.json(); } catch {
        return corsJson({ ok: false, error: 'Invalid JSON.' }, origin, 400);
      }

      if (!validateQuiz(quiz)) {
        return corsJson({ ok: false, error: 'Invalid quiz format.' }, origin, 400);
      }

      // Try up to 5 IDs to avoid collision with active rooms
      for (let attempt = 0; attempt < 5; attempt++) {
        const gameId = generateGameId();
        const roomId = env.GAME_ROOM.idFromName(gameId);
        const room   = env.GAME_ROOM.get(roomId);

        const initRes = await room.fetch(
          new Request(`https://game/room/${gameId}/init`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ gameId, quiz }),
          }),
        );

        if (initRes.ok) {
          const initData = await initRes.json() as { ok: boolean; questionOrder?: string[]; hostSecret?: string };
          return corsJson({ ok: true, gameId, hostSecret: initData.hostSecret, questionOrder: initData.questionOrder ?? [] }, origin);
        }
      }

      return corsJson({ ok: false, error: 'Failed to create game. Try again.' }, origin, 500);
    }

    // ── GET /api/exists/:gameId ── check if room is open ─────────────
    if (url.pathname.startsWith('/api/exists/') && request.method === 'GET') {
      if (isRateLimited(ip, 30)) return corsJson({ ok: false, error: 'Too many requests.' }, origin, 429);

      const gameId = url.pathname.slice('/api/exists/'.length).toUpperCase();
      if (!gameId || !/^[A-Z0-9]{6}$/.test(gameId)) {
        return corsJson({ ok: false, error: 'Invalid room code.' }, origin, 400);
      }

      const roomId = env.GAME_ROOM.idFromName(gameId);
      const room   = env.GAME_ROOM.get(roomId);
      const res    = await room.fetch(new Request(`https://game/room/${gameId}/status`));
      const data   = await res.json();
      return corsJson(data, origin);
    }

    // ── GET /room/:gameId (WebSocket upgrade) ─────────────────────────
    if (url.pathname.startsWith('/room/')) {
      if (isRateLimited(ip, 20)) {
        return new Response('Rate limited', { status: 429 });
      }

      // Validate WebSocket origin
      if (!isOriginAllowed(origin)) {
        return new Response('Forbidden origin', { status: 403 });
      }

      const gameId = url.pathname.slice('/room/'.length).split('/')[0];

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const roomId = env.GAME_ROOM.idFromName(gameId);
      const room   = env.GAME_ROOM.get(roomId);

      // Forward the full request (including WS headers + query params) to the DO
      return room.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
