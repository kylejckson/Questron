// worker/src/GameRoom.ts
// Durable Object — one instance per active game room.
// Uses the WebSocket Hibernation API so the DO sleeps between messages,
// keeping duration charges near-zero (critical for free-tier cost control).

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  MAX_GAMES?: string;
}

// ── Types ─────────────────────────────────────────────────────────────────

interface Player {
  name: string;
  score: number;
  answeredAtMs: number | null;
  selectedOptionId: string | null;
  lastCorrect: boolean;
  delta: number;
  streak: number;
  rejoinToken: string;
}

interface QuizOption {
  id: string;
  label: string;
  shape?: string;
  color?: string;
}

interface QuizQuestion {
  id: string;
  text: string;
  imageUrl?: string | null;
  imageRef?: string | null;
  timeLimitSeconds: number;
  options: QuizOption[];
  correctOptionIds: string[];
  index: number;
}

interface RoundState {
  startMs: number;
  endMs: number;
  awaiting: string[];   // wsTag[] — players who haven't answered yet
  msRemaining?: number; // set when paused
}

interface GameState {
  id: string;
  title: string;
  questions: QuizQuestion[];
  players: Record<string, Player>;            // wsTag -> Player
  disconnectedPlayers: Record<string, Player>; // name  -> Player (for rejoin)
  started: boolean;
  paused: boolean;
  currentIndex: number;
  round: RoundState | null;
  hostTag: string | null;
  hostSecret: string;
}

// ── Utilities ─────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  return arr.map(v => [Math.random(), v] as [number, T]).sort((a, b) => a[0] - b[0]).map(v => v[1]);
}

function sanitizeName(name: string): string {
  return String(name)
    .replace(/<[^>]*>/g, '')
    .replace(/[^\w\s\-'.!]/g, '')
    .slice(0, 24)
    .trim();
}

function createGameState(gameId: string, payload: any): GameState {
  const defaultTime = Math.max(5, Math.min(90, payload.defaultTimeLimitSeconds || 20));
  const shouldShuffle = payload.shuffleQuestions !== false;
  let ordered = Array.isArray(payload.questions) ? [...payload.questions] : [];
  if (shouldShuffle) ordered = shuffle(ordered);

  const shouldShuffleAnswers = payload.shuffleAnswers !== false;
  const questions: QuizQuestion[] = ordered.map((q: any, idx: number) => ({
    id: q.id,
    text: q.text,
    imageUrl: q.imageUrl || null,
    imageRef: q.imageRef || null,
    timeLimitSeconds: Math.max(5, Math.min(90, q.timeLimitSeconds || defaultTime)),
    options: shouldShuffleAnswers ? shuffle([...q.options]) : q.options,
    correctOptionIds: q.correctOptionIds,
    index: idx,
  }));

  return {
    id: gameId,
    title: (payload.title || 'Quiz').slice(0, 80),
    questions,
    players: {},
    disconnectedPlayers: {},
    started: false,
    paused: false,
    currentIndex: -1,
    round: null,
    hostTag: null,
    hostSecret: crypto.randomUUID(),
  };
}

// ── Durable Object ────────────────────────────────────────────────────────

export class GameRoom {
  private _state: GameState | null = null;
  private _wsRateMap = new Map<string, number[]>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  // ── State persistence ────────────────────────────────────────────────

  private async getState(): Promise<GameState | null> {
    if (this._state) return this._state;
    const stored = await this.ctx.storage.get<GameState>('gs');
    this._state = stored ?? null;
    return this._state;
  }

  private async saveState(state: GameState): Promise<void> {
    this._state = state;
    await this.ctx.storage.put('gs', state);
  }

  // ── WebSocket helpers ────────────────────────────────────────────────

  private tag(ws: WebSocket): string {
    const tags = this.ctx.getTags(ws);
    return tags[0] ?? '';
  }

  private send(ws: WebSocket, type: string, payload: unknown): void {
    try { ws.send(JSON.stringify({ type, payload })); } catch { /* hibernating */ }
  }

  private sendAck(ws: WebSocket, reqId: number, payload: unknown): void {
    try { ws.send(JSON.stringify({ reqId, payload })); } catch {}
  }

  private broadcast(type: string, payload: unknown): void {
    const data = JSON.stringify({ type, payload });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch {}
    }
  }

  private toTag(tag: string, type: string, payload: unknown): void {
    const data = JSON.stringify({ type, payload });
    for (const ws of this.ctx.getWebSockets(tag)) {
      try { ws.send(data); } catch {}
    }
  }

  private toHost(state: GameState, type: string, payload: unknown): void {
    if (state.hostTag) this.toTag(state.hostTag, type, payload);
  }

  private broadcastLobby(state: GameState): void {
    const players = Object.values(state.players).map(p => p.name);
    this.broadcast('lobby:update', { players, gameId: state.id, title: state.title });
  }

  private getLeaderboard(state: GameState) {
    return Object.values(state.players)
      .map(p => ({ name: p.name, score: p.score, lastCorrect: !!p.lastCorrect, delta: p.delta || 0, streak: p.streak || 0 }))
      .sort((a, b) => b.score - a.score);
  }

  // ── fetch — handles HTTP and WS upgrades ────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Initialize game state (called from Worker entry on POST /api/create)
    if (url.pathname.endsWith('/init') && request.method === 'POST') {
      const { gameId, quiz } = await request.json() as { gameId: string; quiz: any };
      const state = createGameState(gameId, quiz);
      await this.saveState(state);
      // Return shuffled question order so the host client can look up images per question
      return Response.json({ ok: true, questionOrder: state.questions.map(q => q.id), hostSecret: state.hostSecret });
    }

    // Status check (called from Worker entry on GET /api/exists/:id)
    if (request.headers.get('Upgrade') !== 'websocket') {
      const state = await this.getState();
      if (!state) return Response.json({ ok: false, error: 'Room not found.' });
      if (state.started) return Response.json({ ok: false, error: 'Game already started.' });
      return Response.json({ ok: true, title: state.title });
    }

    // ── WebSocket upgrade ──────────────────────────────────────────────

    const role = url.searchParams.get('role') ?? 'player'; // 'host' | 'player'

    // Validate host secret BEFORE accepting the WebSocket
    if (role === 'host') {
      const state = await this.getState();
      if (!state) {
        return new Response(null, { status: 404, statusText: 'Room not found' });
      }
      const secret = url.searchParams.get('secret');
      // Legacy rooms (no hostSecret) skip the check; new rooms enforce it
      if (state.hostSecret && secret !== state.hostSecret) {
        return new Response(null, { status: 403, statusText: 'Invalid host credentials' });
      }
      state.hostTag = 'host';
      await this.saveState(state);
    }

    const wsTag = role === 'host' ? 'host' : `${role}-${crypto.randomUUID().slice(0, 8)}`;

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [wsTag]);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── WebSocket Hibernation handlers ───────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    // Per-WebSocket rate limiting: 30 messages per 10 seconds
    const wsTag = this.tag(ws);
    const now = Date.now();
    let hits = this._wsRateMap.get(wsTag);
    if (!hits) { hits = []; this._wsRateMap.set(wsTag, hits); }
    while (hits.length > 0 && hits[0]! < now - 10_000) hits.shift();
    hits.push(now);
    if (hits.length > 30) return; // silently drop excess messages

    const state = await this.getState();
    if (!state) {
      try { ws.close(1011, 'Room not found'); } catch {}
      return;
    }

    let msg: { type: string; payload: any; reqId?: number };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    const { type, payload = {}, reqId } = msg;
    const ack = (data: unknown) => { if (reqId !== undefined) this.sendAck(ws, reqId, data); };

    switch (type) {
      case 'host:startGame':   await this.onHostStart(state, wsTag, payload); break;
      case 'host:pause':       await this.onHostPause(state, wsTag); break;
      case 'host:resume':      await this.onHostResume(state, wsTag); break;
      case 'host:next':        await this.onHostNext(state, wsTag, payload); break;
      case 'player:join':      await this.onPlayerJoin(state, wsTag, ws, payload, ack); break;
      case 'player:answer':    await this.onPlayerAnswer(state, wsTag, payload); break;
      case 'player:react':     await this.onPlayerReact(state, wsTag, payload); break;
      case 'game:exists':      ack({ ok: true, title: state.title }); break;
      case 'host:kickPlayer':  await this.onHostKickPlayer(state, wsTag, payload); break;
      default: break; // ignore unknown events (spectators, future events)
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const state = await this.getState();
    if (!state) return;

    const wsTag = this.tag(ws);

    if (wsTag === 'host') {
      this.broadcast('game:cancelled', { reason: 'Host disconnected' });
      await this.ctx.storage.deleteAll();
      this._state = null;
      return;
    }

    const player = state.players[wsTag];
    if (!player) return;

    if (state.started) {
      // Preserve player data for potential rejoin (2 min window)
      state.disconnectedPlayers[player.name] = { ...player };
    }
    delete state.players[wsTag];

    // Remove from awaiting if in active round
    if (state.round) {
      state.round.awaiting = state.round.awaiting.filter(t => t !== wsTag);
    }

    this.broadcastLobby(state);

    // If round active and everyone left, clean up timer
    if (state.round && Object.keys(state.players).length === 0) {
      await this.ctx.storage.deleteAlarm();
      state.round = null;
    }

    await this.saveState(state);
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    // handled via close
  }

  // ── Alarm (question timer OR post-game cleanup) ──────────────────────

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state) return;

    // Post-game cleanup alarm (state.round is null, game is over)
    if (!state.round) {
      await this.ctx.storage.deleteAll();
      this._state = null;
      return;
    }

    if (state.paused) return;
    await this.endRound(state);
  }

  // ── Game event handlers ──────────────────────────────────────────────

  private async onHostStart(state: GameState, wsTag: string, payload: any = {}): Promise<void> {
    if (wsTag !== 'host' || state.started) return;
    state.started = true;
    await this.saveState(state);
    this.broadcast('game:started', { title: state.title });
    await this.startQuestion(state, payload.imageData ?? null);
  }

  private async onHostPause(state: GameState, wsTag: string): Promise<void> {
    if (wsTag !== 'host' || !state.round || state.paused) return;
    state.paused = true;
    const msRemaining = Math.max(0, state.round.endMs - Date.now());
    state.round.msRemaining = msRemaining;
    await this.ctx.storage.deleteAlarm(); // cancel the active timer
    await this.saveState(state);
    this.broadcast('game:paused', { msRemaining });
  }

  private async onHostResume(state: GameState, wsTag: string): Promise<void> {
    if (wsTag !== 'host' || !state.round || !state.paused) return;
    const msRemaining = state.round.msRemaining ?? 5000;
    state.paused = false;
    state.round.endMs = Date.now() + msRemaining;
    state.round.msRemaining = undefined;
    await this.ctx.storage.setAlarm(state.round.endMs);
    await this.saveState(state);
    this.broadcast('game:resumed', { msRemaining });
  }

  private async onHostNext(state: GameState, wsTag: string, payload: any = {}): Promise<void> {
    if (wsTag !== 'host') return;
    await this.startQuestion(state, payload.imageData ?? null);
  }

  private async onPlayerJoin(
    state: GameState,
    wsTag: string,
    ws: WebSocket,
    payload: { gameId?: string; name?: string; rejoinToken?: string },
    ack: (data: unknown) => void,
  ): Promise<void> {
    if (!payload.name) { ack({ ok: false, error: 'Name required.' }); return; }

    const safeName = sanitizeName(payload.name);
    if (!safeName) { ack({ ok: false, error: 'Invalid name.' }); return; }

    if (state.started) {
      const disc = state.disconnectedPlayers[safeName];
      if (!disc) {
        ack({ ok: false, error: 'Game already started.' });
        return;
      }
      // Validate rejoin token (skip for legacy players without token)
      if (disc.rejoinToken && payload.rejoinToken !== disc.rejoinToken) {
        ack({ ok: false, error: 'Invalid rejoin credentials.' });
        return;
      }
      // Rejoin
      delete state.disconnectedPlayers[safeName];
      state.players[wsTag] = { ...disc };
      await this.saveState(state);
      ack({ ok: true, gameId: state.id, title: state.title, reconnected: true, rejoinToken: disc.rejoinToken });
      this.send(ws, 'game:started', { title: state.title });
      this.broadcastLobby(state);
      return;
    }

    if (Object.keys(state.players).length >= 100) {
      ack({ ok: false, error: 'Game is full.' });
      return;
    }

    // Don't allow duplicate names in lobby
    const nameTaken = Object.values(state.players).some(p => p.name === safeName);
    if (nameTaken) {
      ack({ ok: false, error: 'Name already taken.' });
      return;
    }

    const rejoinToken = crypto.randomUUID();
    state.players[wsTag] = {
      name: safeName,
      score: 0,
      answeredAtMs: null,
      selectedOptionId: null,
      lastCorrect: false,
      delta: 0,
      streak: 0,
      rejoinToken,
    };
    await this.saveState(state);
    ack({ ok: true, gameId: state.id, title: state.title, questionCount: state.questions.length, rejoinToken });
    this.broadcastLobby(state);
  }

  private async onPlayerAnswer(
    state: GameState,
    wsTag: string,
    payload: { gameId?: string; questionId?: string; optionId?: string },
  ): Promise<void> {
    if (!state.round || state.paused) return;
    const p = state.players[wsTag];
    if (!p) return;

    const q = state.questions[state.currentIndex];
    if (!q || q.id !== payload.questionId) return;
    if (p.selectedOptionId !== null) return; // already answered

    // Validate optionId belongs to this question
    const optionId = payload.optionId ?? null;
    if (!optionId || !q.options.some(opt => opt.id === optionId)) return;

    p.selectedOptionId = optionId;
    p.answeredAtMs = Date.now();
    state.round.awaiting = state.round.awaiting.filter(t => t !== wsTag);

    // Confirm lock to the player
    this.toTag(wsTag, 'player:locked', { optionId: payload.optionId });

    // Progress to host
    const answeredCount = Object.values(state.players).filter(pl => pl.selectedOptionId !== null).length;
    this.toHost(state, 'round:progress', { answeredCount, totalCount: Object.keys(state.players).length });

    // End early if all answered
    if (state.round.awaiting.length === 0) {
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
      await this.endRound(state);
    } else {
      await this.saveState(state);
    }
  }

  private async onHostKickPlayer(
    state: GameState,
    wsTag: string,
    payload: { playerName?: string },
  ): Promise<void> {
    if (wsTag !== 'host' || state.started) return;
    const name = payload.playerName;
    if (!name) return;
    const entry = Object.entries(state.players).find(([, p]) => p.name === name);
    if (!entry) return;
    const [playerTag] = entry;
    // Notify and disconnect the player
    this.toTag(playerTag, 'player:kicked', { reason: 'You were removed from the game by the host.' });
    for (const ws of this.ctx.getWebSockets(playerTag)) {
      try { ws.close(1000, 'Removed by host'); } catch {}
    }
    delete state.players[playerTag];
    await this.saveState(state);
    this.broadcastLobby(state);
  }

  private async onPlayerReact(
    state: GameState,
    wsTag: string,
    payload: { gameId?: string; emoji?: string },
  ): Promise<void> {
    if (!state.started) return;
    const p = state.players[wsTag];
    if (!p) return;
    const allowed = ['👏', '🔥', '😂', '💀', '🎉', '🤯'];
    if (!allowed.includes(payload.emoji ?? '')) return;
    this.toHost(state, 'reaction:received', { name: p.name, emoji: payload.emoji });
  }

  // ── Game flow ─────────────────────────────────────────────────────────

  private async startQuestion(state: GameState, imageData?: string | null): Promise<void> {
    state.currentIndex++;

    if (state.currentIndex >= state.questions.length) {
      await this.endGame(state);
      return;
    }

    const q = state.questions[state.currentIndex];
    const startMs = Date.now();
    const endMs = startMs + q.timeLimitSeconds * 1000;

    // Reset per-round player state
    for (const p of Object.values(state.players)) {
      p.answeredAtMs = null;
      p.selectedOptionId = null;
      p.lastCorrect = false;
      p.delta = 0;
    }

    state.paused = false;
    state.round = {
      startMs,
      endMs,
      awaiting: Object.keys(state.players),
    };

    // Set alarm for end of question
    await this.ctx.storage.setAlarm(endMs);
    await this.saveState(state);

    // Safe question payload — correct answers excluded
    const safeQ = {
      id: q.id,
      index: state.currentIndex,
      total: state.questions.length,
      text: q.text,
      imageUrl: q.imageUrl ?? null,
      imageData: imageData ?? null,
      timeLimitSeconds: q.timeLimitSeconds,
      options: q.options,
    };
    this.broadcast('question:show', safeQ);
  }

  private async endRound(state: GameState): Promise<void> {
    if (!state.round) return;
    const q = state.questions[state.currentIndex];
    const { startMs, endMs } = state.round;

    // Score players
    for (const p of Object.values(state.players)) {
      const answered  = p.selectedOptionId !== null;
      const correct   = answered && q.correctOptionIds.includes(p.selectedOptionId!);
      p.lastCorrect   = correct;
      let delta = 0;
      if (correct && p.answeredAtMs !== null) {
        p.streak += 1;
        const timeLimit    = q.timeLimitSeconds * 1000;
        const remaining    = Math.max(0, endMs - p.answeredAtMs);
        const base         = Math.floor(500 + 500 * (remaining / timeLimit));
        // Streak multiplier: +10% per streak level above 1, capped at +50%
        const streakMult   = p.streak >= 2 ? Math.min(1.5, 1.0 + (p.streak - 1) * 0.1) : 1.0;
        delta = Math.floor(base * streakMult);
        p.score += delta;
      } else {
        p.streak = 0;
      }
      p.delta = delta;
    }

    // Counts per option (same order as q.options)
    const optionCounts: Record<string, number> = {};
    for (const opt of q.options) optionCounts[opt.id] = 0;
    for (const p of Object.values(state.players)) {
      if (p.selectedOptionId && optionCounts[p.selectedOptionId] !== undefined) {
        optionCounts[p.selectedOptionId]++;
      }
    }
    const counts = q.options.map(opt => optionCounts[opt.id] ?? 0);

    // Player choices per option (for shame display)
    const playerChoices: Record<string, string[]> = {};
    for (const opt of q.options) playerChoices[opt.id] = [];
    for (const p of Object.values(state.players)) {
      if (p.selectedOptionId && playerChoices[p.selectedOptionId] !== undefined) {
        playerChoices[p.selectedOptionId].push(p.name);
      }
    }

    // Review stats
    const vals = Object.values(state.players);
    const totalAnswered   = vals.filter(p => p.selectedOptionId !== null).length;
    const correctAnswered = vals.filter(p => p.lastCorrect).length;
    const percentCorrect  = totalAnswered > 0 ? Math.round((correctAnswered / totalAnswered) * 100) : 0;

    let fastestName: string | null = null;
    let fastestMs = Infinity;
    for (const p of vals) {
      if (p.lastCorrect && p.answeredAtMs !== null && p.answeredAtMs < fastestMs) {
        fastestMs   = p.answeredAtMs;
        fastestName = p.name;
      }
    }

    const leaderboard = this.getLeaderboard(state);

    this.broadcast('question:reveal', {
      correctOptionIds: q.correctOptionIds,
      index: state.currentIndex,
      total: state.questions.length,
      leaderboard,
      counts,
      playerChoices,
      percentCorrect,
      fastestName,
    });

    state.round = null;
    await this.saveState(state);

    // Tell host they can advance
    this.toHost(state, 'host:canAdvance', { canAdvance: true });
  }

  private async endGame(state: GameState): Promise<void> {
    const leaderboard = this.getLeaderboard(state);
    this.broadcast('game:over', { leaderboard });
    // Keep state for a short while so stragglers can receive game:over, then clean up
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    state.started = false; // prevents re-entry
    await this.saveState(state);
  }
}
