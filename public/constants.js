// constants.js — shared config used by host.js and player.js

// ── Game server URL ───────────────────────────────────────────────────────
// Local-dev override is ONLY allowed when the page itself is served from
// localhost / 127.0.0.1 — this prevents phishing via ?server=evil.com links.
const _isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const _serverOverride = _isLocalDev
  ? new URLSearchParams(location.search).get('server')
  : null;
const GAME_SERVER_URL = _serverOverride
  ? _serverOverride.replace(/^ws/, 'http')
  : _isLocalDev
    ? 'http://localhost:8787'
    : 'https://questron-game.kyden.workers.dev';
const GAME_SERVER_WS = GAME_SERVER_URL.replace(/^http/, 'ws');

// ── WebSocket wrapper ─────────────────────────────────────────────────────
// Provides a Socket.IO-like .on() / .emit(type, payload, ack?) API over a
// single native WebSocket, with auto-reconnect and message queuing.
function createSocket() {
  const _listeners  = {};   // event -> [handler, ...]
  const _pending    = {};   // reqId -> ack callback
  let   _reqId      = 0;
  let   _ws         = null;
  let   _queue      = [];   // messages sent before open
  let   _wsUrl      = null;
  let   _destroyed  = false;

  function _dispatch(type, payload) {
    (_listeners[type] || []).forEach(fn => fn(payload));
  }

  function _rawSend(data) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(data);
    } else {
      _queue.push(data);
    }
  }

  function _connect(wsUrl) {
    _wsUrl = wsUrl;
    try { _ws = new WebSocket(wsUrl); } catch (e) { _dispatch('connect_error', e); return; }

    _ws.onopen = () => {
      const queued = _queue.splice(0);
      queued.forEach(d => _ws.send(d));
      _dispatch('connect', {});
    };

    _ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      // Acknowledgement reply
      if (msg.reqId !== undefined && _pending[msg.reqId]) {
        _pending[msg.reqId](msg.payload);
        delete _pending[msg.reqId];
      } else if (msg.type) {
        _dispatch(msg.type, msg.payload);
      }
    };

    _ws.onclose = () => {
      if (!_destroyed && _wsUrl) {
        _dispatch('disconnect', {});
        setTimeout(() => _connect(_wsUrl), 1500);
      }
    };

    _ws.onerror = () => _dispatch('connect_error', {});
  }

  return {
    on(event, fn)           { (_listeners[event] = _listeners[event] || []).push(fn); return this; },
    off(event, fn)          { _listeners[event] = (_listeners[event] || []).filter(f => f !== fn); return this; },
    emit(type, payload, ack) {
      if (typeof ack === 'function') {
        const id = ++_reqId;
        _pending[id] = ack;
        _rawSend(JSON.stringify({ type, payload, reqId: id }));
      } else {
        _rawSend(JSON.stringify({ type, payload }));
      }
      return this;
    },
    connect(wsUrl)          { _connect(wsUrl); },
    destroy()               { _destroyed = true; _wsUrl = null; if (_ws) _ws.close(); },
    get connected()         { return _ws && _ws.readyState === WebSocket.OPEN; },
  };
}

const ANSWER_STYLES = [
  { color: 'opt-a', shape: 'A', label: 'A' },
  { color: 'opt-b', shape: 'B', label: 'B' },
  { color: 'opt-c', shape: 'C', label: 'C' },
  { color: 'opt-d', shape: 'D', label: 'D' },
];

// Player colour palette — PULSE (warm game-show, not AI-SaaS)
const PLAYER_COLORS = [
  '#b8ff3c','#ff5c1a','#ffd23f','#00e8a0',
  '#ff7733','#a0e820','#ff9500','#00c87a',
  '#ffe040','#ff4d00','#80ff20','#00a870',
];

// Return deterministic color for a player name
function playerColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PLAYER_COLORS[h % PLAYER_COLORS.length];
}

// Initials avatar (up to 2 chars)
function playerInitials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ── SVG Ring Timer ─────────────────────────────────────────────────────────
// Usage: stopFn = startTimerRing('myContainerId', seconds, optionalOnTick)
//   The container must have .timer-ring__fill and .timer-number children.
//   Returns a stop/cancel function.

const RING_CIRCUMFERENCE = 283; // matches CSS stroke-dasharray (r=45, C≈282.7)

function startTimerRing(containerId, seconds, onTick) {
  const container = document.getElementById(containerId);
  if (!container) return () => {};

  const fill = container.querySelector('.timer-ring__fill');
  const num  = container.querySelector('.timer-number');
  if (!fill || !num) return () => {};

  // Show container
  container.style.display = 'flex';
  container.classList.remove('urgent', 'warn');
  fill.style.strokeDashoffset = '0';
  num.textContent = seconds;

  const endTime = Date.now() + seconds * 1000;
  let raf;

  function tick() {
    const msLeft  = endTime - Date.now();
    const secLeft = Math.max(0, Math.ceil(msLeft / 1000));
    const pct     = Math.max(0, msLeft / (seconds * 1000));

    fill.style.strokeDashoffset = ((1 - pct) * RING_CIRCUMFERENCE).toFixed(2);
    num.textContent = secLeft;

    container.classList.remove('urgent', 'warn');
    if (secLeft <= 5)       container.classList.add('urgent');
    else if (secLeft <= 10) container.classList.add('warn');

    if (onTick) onTick(secLeft);

    if (msLeft > 0) {
      raf = requestAnimationFrame(tick);
    }
  }

  requestAnimationFrame(() => requestAnimationFrame(tick));

  return function stop() {
    cancelAnimationFrame(raf);
    container.style.display = 'none';
    container.classList.remove('urgent', 'warn');
  };
}

function stopTimerRing(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.style.display = 'none';
  container.classList.remove('urgent', 'warn');
}

// Legacy stubs so any call sites that still use the old names don't crash
function startBlockTimer(seconds, onTick) { return () => {}; }
function stopBlockTimer() {}

// ── PULSE Background System ───────────────────────────────────────────────
function initPulseBackground() {
  if (document.querySelector('.bg-blobs')) return;

  // Lava blobs (dark warm tones — ASCII canvas adds the color on top)
  const blobs = document.createElement('div');
  blobs.className = 'bg-blobs';
  blobs.innerHTML = '<div class="bg-blob"></div><div class="bg-blob"></div><div class="bg-blob"></div><div class="bg-blob"></div>';
  document.body.insertBefore(blobs, document.body.firstChild);

  // ASCII canvas — maps blob positions to colored ASCII characters
  const ASCII_CHARS = '·∘◦·.·∘◦○•·+';
  const CELL = 18;
  const BLOBS_DATA = [
    { x: -0.08, y: -0.10, rgb: [184,255,60],   r: 0.55 }, // lime
    { x: 1.05,  y: 1.15,  rgb: [255,92,26],    r: 0.50 }, // orange
    { x: 0.75,  y: 0.40,  rgb: [0,232,160],    r: 0.45 }, // mint
    { x: 0.55,  y: 0.20,  rgb: [255,210,63],   r: 0.42 }, // gold
  ];

  const cvs = document.createElement('canvas');
  cvs.id = 'bg-ascii-canvas';
  cvs.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;contain:strict;-webkit-backface-visibility:hidden;backface-visibility:hidden;';
  document.body.insertBefore(cvs, blobs.nextSibling);
  const ctx = cvs.getContext('2d');

  let t = 0, lastTs = 0, rafId = null;
  const FRAME_INTERVAL = 110; // ~9 fps

  function drawAscii(ts) {
    rafId = requestAnimationFrame(drawAscii);
    if (ts - lastTs < FRAME_INTERVAL) return;
    lastTs = ts;

    const W = window.innerWidth;
    const H = window.innerHeight;
    if (cvs.width !== W || cvs.height !== H) {
      cvs.width = W; cvs.height = H;
    }
    ctx.clearRect(0, 0, W, H);

    const cols = Math.ceil(W / CELL);
    const rows = Math.ceil(H / CELL);
    ctx.font = `${Math.round(CELL * 0.62)}px 'Space Mono', monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const nx = c / cols;
        const ny = r / rows;
        let bright = 0, R = 0, G = 0, B = 0;

        for (const bd of BLOBS_DATA) {
          // Slight drift matching CSS blob animation phase
          const bx = bd.x + Math.sin(t * 0.00025 + bd.r * 9)  * 0.055;
          const by = bd.y + Math.cos(t * 0.00018 + bd.r * 7)  * 0.055;
          const d  = Math.hypot(nx - bx, ny - by);
          const b  = Math.max(0, 1 - d / bd.r);
          bright += b;
          R += bd.rgb[0] * b;
          G += bd.rgb[1] * b;
          B += bd.rgb[2] * b;
        }

        if (bright < 0.04) continue;

        const idx  = Math.min(ASCII_CHARS.length - 1, Math.floor(bright * (ASCII_CHARS.length - 0.5)));
        const ch   = ASCII_CHARS[idx];
        const a    = Math.min(0.55, 0.06 + bright * 0.52);
        ctx.fillStyle = `rgba(${Math.round(R/bright)},${Math.round(G/bright)},${Math.round(B/bright)},${a.toFixed(3)})`;
        ctx.fillText(ch, c * CELL + 2, r * CELL + CELL * 0.52);
      }
    }
    t += 16;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(rafId);
    else requestAnimationFrame(drawAscii);
  });
  requestAnimationFrame(drawAscii);

  // Dither overlay
  const dither = document.createElement('div');
  dither.className = 'bg-dither';
  document.body.insertBefore(dither, cvs.nextSibling);

  // Grid lines
  const grid = document.createElement('div');
  grid.className = 'bg-grid';
  document.body.insertBefore(grid, dither.nextSibling);

  // CRT scanlines
  const scan = document.createElement('div');
  scan.className = 'bg-scanlines';
  document.body.insertBefore(scan, grid.nextSibling);
}

// ── Card Flip Reveal (2-phase JS flip) ────────────────────────────────
function flipRevealCard(btn, resultClass, delay) {
  delay = delay || 0;
  setTimeout(function () {
    if (!btn || !btn.isConnected) return;
    btn.style.setProperty('--rx', '0deg');
    btn.style.setProperty('--ry', '0deg');
    btn.classList.add('card-flipping');
    setTimeout(function () {
      btn.classList.remove('card-flipping');
      // For icon
      if (resultClass === 'correct' || resultClass === 'player-correct') {
        const icon = btn.querySelector('.answer-icon');
        if (icon) { icon.textContent = '✓'; icon.style.opacity = '1'; }
      }
      btn.classList.add(resultClass, 'card-flip-in');
      // Remove animation class after it completes
      setTimeout(() => btn.classList.remove('card-flip-in'), 320);
    }, 255);
  }, delay);
}

// ── Particle Burst (on correct answer reveal) ─────────────────────────────
const PULSE_PARTICLE_COLORS = [
  '#b8ff3c', '#ff7733', '#ffd23f', '#00e8a0', '#ff5c1a', '#ceff6e', '#00c870',
];

function triggerParticleBurst(cardEl) {
  if (!cardEl) return;

  const burst = document.createElement('div');
  burst.className = 'particle-burst';
  cardEl.style.position = 'relative';
  cardEl.appendChild(burst);

  const count = 12;
  for (let i = 0; i < count; i++) {
    const p   = document.createElement('div');
    p.className = 'particle';
    const angle = (i / count) * 2 * Math.PI + (Math.random() - 0.5) * 0.4;
    const dist  = 40 + Math.random() * 55;
    const px    = Math.cos(angle) * dist;
    const py    = Math.sin(angle) * dist;
    const color = PULSE_PARTICLE_COLORS[i % PULSE_PARTICLE_COLORS.length];
    const dur   = 0.5 + Math.random() * 0.35;
    const size  = 4 + Math.random() * 5;
    // Alternate shapes
    if (i % 3 === 1) { p.style.borderRadius = '0'; p.style.width = size * 0.6 + 'px'; p.style.height = size * 1.6 + 'px'; }
    else if (i % 3 === 2) { p.style.borderRadius = '2px'; p.style.width = size + 'px'; p.style.height = size + 'px'; }
    else { p.style.borderRadius = '50%'; p.style.width = size + 'px'; p.style.height = size + 'px'; }
    p.style.background    = color;
    p.style.boxShadow     = `0 0 8px ${color}`;
    p.style.setProperty('--px', px + 'px');
    p.style.setProperty('--py', py + 'px');
    p.style.animationDuration = dur + 's';
    p.style.animationDelay   = (Math.random() * 0.08) + 's';
    burst.appendChild(p);
  }

  setTimeout(() => burst.remove(), 1100);
}

// ── Confetti ───────────────────────────────────────────────────────────────
function launchConfetti() {
  const container = document.createElement('div');
  container.className = 'confetti-container';
  document.body.appendChild(container);

  const colors = [
    'var(--spark)', 'var(--opt-a-color)', 'var(--opt-b-color)',
    'var(--opt-c-color)', 'var(--opt-d-color)', 'var(--correct)',
    '#fbbf24', '#818cf8',
  ];

  for (let i = 0; i < 72; i++) {
    const p     = document.createElement('div');
    p.className = 'confetti-piece';
    const type  = Math.random();
    const size  = 6 + Math.random() * 8;
    const color = colors[Math.floor(Math.random() * colors.length)];

    if (type < 0.4) {
      // Circle
      p.style.cssText = `left:${Math.random()*100}%;width:${size}px;height:${size}px;border-radius:50%;background:${color};animation-duration:${1.4 + Math.random()*2}s;animation-delay:${Math.random()*0.9}s;`;
    } else if (type < 0.75) {
      // Rectangle
      p.style.cssText = `left:${Math.random()*100}%;width:${size * 0.6}px;height:${size * 1.4}px;background:${color};border-radius:2px;animation-duration:${1.6 + Math.random()*2.2}s;animation-delay:${Math.random()*1.1}s;`;
    } else {
      // Strip
      p.style.cssText = `left:${Math.random()*100}%;width:3px;height:${12 + Math.random()*10}px;background:${color};border-radius:2px;animation-duration:${1.8 + Math.random()*2.4}s;animation-delay:${Math.random()*1.3}s;`;
    }
    container.appendChild(p);
  }

  setTimeout(() => container.remove(), 5500);
}

// ── Leaderboard ────────────────────────────────────────────────────────────
function buildLeaderboard(leaderboard, selfName = null) {
  const rankLabel = (i) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
  const rankClass = (i) => i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';

  return leaderboard.map((p, i) => {
    const isSelf   = selfName && p.name === selfName;
    const delta    = p.delta > 0 ? `+${p.delta.toLocaleString()}` : '';
    const streak   = (p.streak || 0) >= 2 ? `<span class="lb-streak">🔥${p.streak}</span>` : '';
    const pct      = leaderboard[0]?.score > 0
      ? Math.round((p.score / leaderboard[0].score) * 100) : 0;
    const color    = playerColor(p.name);
    const initials = playerInitials(p.name);

    return `
      <li class="lb-row${p.lastCorrect ? ' correct' : ''}${isSelf ? ' self' : ''}">
        <div class="lb-bar" style="--pct:${pct}%;"></div>
        <div class="lb-avatar" style="background:${color};">${escHtml(initials)}</div>
        <span class="lb-rank ${rankClass(i)}">${rankLabel(i)}</span>
        <span class="lb-name">${escHtml(p.name)}${streak}</span>
        <span class="lb-score">${p.score.toLocaleString()}</span>
        ${delta ? `<span class="lb-delta">${delta}</span>` : '<span class="lb-delta"></span>'}
      </li>`;
  }).join('');
}

// ── Race / "Signal Rush" between-question leaderboard ────────────────────────
function buildRaceLeaderboard(leaderboard, prevLeaderboard = [], selfName = null) {
  const maxScore = leaderboard[0]?.score || 1;
  const total    = leaderboard.length;
  const prevRankMap = new Map();
  prevLeaderboard.forEach((p, i) => prevRankMap.set(p.name, i));

  return leaderboard.map((p, i) => {
    const isSelf   = selfName && p.name === selfName;
    const isLeader = i === 0;
    const pct      = maxScore > 0 ? Math.round((p.score / maxScore) * 100) : 0;
    const color    = playerColor(p.name);
    const initials = playerInitials(p.name);
    const delta    = p.delta > 0 ? `+${p.delta.toLocaleString()}` : '';
    const streak   = (p.streak || 0) >= 2 ? `<span class="lb-streak">\ud83d\udd25${p.streak}</span>` : '';
    // Reverse stagger: best player (#1) slides in last for dramatic reveal
    const delay    = ((total - 1 - i) * 0.07).toFixed(2);
    // Rank change badge
    let rankBadge = '';
    if (prevLeaderboard.length > 0) {
      const prevRank = prevRankMap.get(p.name);
      if (prevRank !== undefined && prevRank !== i) {
        const diff = prevRank - i; // positive = climbed
        rankBadge = diff > 0
          ? `<span class="race-rank-badge up">\u25b2${diff}</span>`
          : `<span class="race-rank-badge down">\u25bc${Math.abs(diff)}</span>`;
      }
    }
    const rankEmoji  = i === 0 ? '\ud83e\udd47' : i === 1 ? '\ud83e\udd48' : i === 2 ? '\ud83e\udd49' : `#${i + 1}`;
    const rankStyle  = i < 3 ? 'font-size:1.15rem;' : 'font-size:0.82rem;font-family:var(--font-display);font-weight:800;color:var(--text-subtle);';
    const barColor   = p.lastCorrect ? 'var(--lime)' : (pct > 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.06)');

    return `<div class="race-row${isSelf ? ' is-self' : ''}${isLeader ? ' is-leader' : ''}" style="--race-delay:${delay}s;--pct:${pct}%;">
      <div class="race-rank"><span style="${rankStyle}">${rankEmoji}</span>${rankBadge}</div>
      <div class="race-avatar" style="background:${color};">${escHtml(initials)}</div>
      <div class="race-info">
        <div class="race-name">${escHtml(p.name)}${streak}</div>
        <div class="race-bar-track"><div class="race-bar-fill" style="background:${barColor};"></div></div>
      </div>
      <div class="race-score-col">
        <span class="race-score">${p.score.toLocaleString()}</span>
        ${delta ? `<span class="race-delta">${delta}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── Podium ─────────────────────────────────────────────────────────────────
function buildPodium(leaderboard) {
  const slot = (p, cls, rankEmoji) => {
    if (!p) return `<div class="podium-place ${cls}"></div>`;
    const color    = playerColor(p.name);
    const initials = playerInitials(p.name);
    return `
      <div class="podium-place ${cls}">
        <div class="podium-avatar" style="background:${color};">${escHtml(initials)}</div>
        <div class="podium-name">${escHtml(p.name)}</div>
        <div class="podium-score">${p.score.toLocaleString()} pts</div>
        <div class="podium-block"><span class="podium-rank">${rankEmoji}</span></div>
      </div>`;
  };
  return `<div class="podium">
    ${slot(leaderboard[1], 'p2', '🥈')}
    ${slot(leaderboard[0], 'p1', '🥇')}
    ${slot(leaderboard[2], 'p3', '🥉')}
  </div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── Floating Emoji Reaction ────────────────────────────────────────────────
function showFloatingReaction(emoji, name) {
  const x = 20 + Math.random() * 60; // % from left, keep away from edges

  const emojiEl = document.createElement('div');
  emojiEl.className = 'floating-reaction';
  emojiEl.textContent = emoji;
  emojiEl.style.left   = x + '%';
  emojiEl.style.bottom = '80px';
  document.body.appendChild(emojiEl);

  if (name) {
    const nameEl = document.createElement('div');
    nameEl.className   = 'reaction-source';
    nameEl.textContent = name;
    nameEl.style.left   = x + '%';
    nameEl.style.bottom = '60px';
    document.body.appendChild(nameEl);
    setTimeout(() => nameEl.remove(), 2800);
  }

  setTimeout(() => emojiEl.remove(), 2800);
}

// Legacy alias
function showSignalBurst(text, name) { showFloatingReaction(text, name); }

// ── Sound / Mode toggles ───────────────────────────────────────────────────
function initSoundToggle() {
  // PULSE is always dark — inject background on init
  initPulseBackground();

  let muted = localStorage.getItem('questron_muted') === '1';

  const btn = document.createElement('button');
  btn.className = 'sound-toggle';
  btn.title     = 'Toggle sound';
  btn.innerHTML = muted ? '🔇 Off' : '🔊 On';
  if (muted) btn.classList.add('muted');
  document.body.appendChild(btn);

  function applyMute() {
    document.querySelectorAll('audio').forEach(a => { a.muted = muted; });
  }

  btn.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('questron_muted', muted ? '1' : '0');
    btn.innerHTML = muted ? '🔇 Off' : '🔊 On';
    btn.classList.toggle('muted', muted);
    applyMute();
  });

  applyMute();
  return { get muted() { return muted; }, applyMute };
}
