// public/host.js
const socket = createSocket();
let gameId   = null;
let payload  = null;
let hostSecret = '';
let stopTimer = null;
let totalPlayers = 0;
let optionIdOrder = [];
let autoAdvanceTimer = null;
let revealAutoTimer  = null;  // 10s delay before auto-showing leaderboard
let revealCountdownInterval = null;
let isPaused = false;
let prevLeaderboard = [];
// ── Library browser state ────────────────────────────────────
let hostLibraryAll     = [];
let hostLibrarySubject = '';
let hostLibraryDiff    = '';
let hostLibrarySearch  = '';
// ── Image support ───────────────────────────────────
let imageMap         = new Map(); // imageRef filename → base64 dataURL
let questionOrder    = [];        // server-shuffled question IDs in play order
let hostCurrentIndex = -1;        // mirrors server-side currentIndex

// Returns the base64 dataURL for the question at position idx, or null.
function getImageData(idx) {
  const qId = questionOrder[idx];
  if (!qId) return null;
  const q = (payload?.questions || []).find(q => q.id === qId);
  if (!q?.imageRef) return null;
  return imageMap.get(q.imageRef) || null;
}

// ── Sound toggle ─────────────────────────────────────────────
const sound = initSoundToggle();

// ── Element refs ─────────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = {
  screenCreate:      $('screenCreate'),
  screenLobby:       $('screenLobby'),
  screenPlay:        $('screenPlay'),
  screenLeaderboard: $('screenLeaderboard'),
  screenOver:        $('screenOver'),
  screenCancelled:   $('screenCancelled'),

  copyCodeBtn:    $('copyCodeBtn'),
  qrCanvas:       $('qrCanvas'),

  // Create screen — new elements
  resetPinBtn:         $('resetPinBtn'),
  hostSearchInput:     $('hostSearchInput'),
  hostSubjectChips:    $('hostSubjectChips'),
  hostDiffChips:       $('hostDiffChips'),
  hostQuizGrid:        $('hostQuizGrid'),
  settingShuffleQ:     $('settingShuffleQ'),
  settingShuffleA:     $('settingShuffleA'),
  settingTimeOverride: $('settingTimeOverride'),
  settingRevealSecs:   $('settingRevealSecs'),
  settingLbSecs:       $('settingLbSecs'),
  clearQuizBtn:        $('clearQuizBtn'),
  selectedIcon:        $('selectedIcon'),

  dropZone:       $('dropZone'),
  jsonFile:       $('jsonFile'),
  createBtn:      $('createBtn'),
  createMsg:      $('createMsg'),
  quizPreview:    $('quizPreview'),
  previewTitle:   $('previewTitle'),
  previewQCount:  $('previewQCount'),
  previewTime:    $('previewTime'),

  lobbyTitle:     $('lobbyTitle'),
  gameId:         $('gameId'),
  joinUrl:        $('joinUrl'),
  lobbyPlayers:   $('lobbyPlayers'),
  lobbyEmpty:     $('lobbyEmpty'),
  playerCount:    $('playerCount'),
  startBtn:       $('startBtn'),

  qText:          $('qText'),
  qImage:         $('qImage'),
  qIndex:         $('qIndex'),
  qTotal:         $('qTotal'),
  answers:        $('answers'),
  barChart:       $('barChart'),
  nextBtn:        $('nextBtn'),
  lbNextBtn:     $('lbNextBtn'),
  answeredCounter:$('answeredCounter'),
  answeredFill:   $('answeredFill'),
  answeredText:   $('answeredText'),
  hostProgressBar:$('hostProgressBar'),
  pauseBtn:       $('pauseBtn'),
  music:          $('music'),
  reveal:         $('reveal'),

  reviewStats:        $('reviewStats'),
  autoAdvanceWrap:    $('autoAdvanceWrap'),
  autoAdvanceFill:    $('autoAdvanceFill'),
  autoAdvanceSec:     $('autoAdvanceSec'),
  autoAdvanceCancelBtn: $('autoAdvanceCancelBtn'),

  revealAutoWrap:      $('revealAutoWrap'),
  revealAutoFill:      $('revealAutoFill'),
  revealAutoSec:       $('revealAutoSec'),
  revealAutoCancelBtn: $('revealAutoCancelBtn'),

  board:          $('board'),
  podiumWrap:     $('podiumWrap'),
  finalBoard:     $('finalBoard'),
  backToCreateBtn:$('backToCreateBtn'),
  cancelReason:   $('cancelReason'),
  end:            $('end'),
};

// ── Screen management ─────────────────────────────────────────
function showOnly(screenEl) {
  [el.screenCreate, el.screenLobby, el.screenPlay,
   el.screenLeaderboard, el.screenOver, el.screenCancelled]
    .forEach(s => s.classList.add('hidden'));
  screenEl.classList.remove('hidden');
}

// ── Copy code button ──────────────────────────────────────────
el.copyCodeBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(gameId).then(() => {
    el.copyCodeBtn.textContent = 'Copied! \u2713';
    el.copyCodeBtn.classList.add('copied');
    setTimeout(() => {
      el.copyCodeBtn.textContent = 'Copy Code';
      el.copyCodeBtn.classList.remove('copied');
    }, 2000);
  });
});

// ── Reset PIN (creates fresh game with same payload) ───────────────
if (el.resetPinBtn) {
  el.resetPinBtn.addEventListener('click', async () => {
    if (!payload) return;
    el.resetPinBtn.disabled = true;
    el.resetPinBtn.textContent = 'Creating…';
    try {
      const res  = await fetch(`${GAME_SERVER_URL}/api/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCreatePayload()),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed');
      gameId = data.gameId;
      hostSecret       = data.hostSecret || '';
      questionOrder    = data.questionOrder || [];
      hostCurrentIndex = -1;
      // Reconnect to new room (old socket auto-sends game:cancelled to old lobby)
      socket.connect(`${GAME_SERVER_WS}/room/${gameId}?role=host&secret=${encodeURIComponent(hostSecret)}`);
      // Re-render PIN
      el.gameId.innerHTML = '';
      String(gameId).split('').forEach((ch, i) => {
        const d = document.createElement('div');
        d.className = 'game-code-char';
        d.textContent = ch;
        d.style.setProperty('--char-i', i);
        setTimeout(() => d.classList.add('pop'), 80 + i * 120);
        el.gameId.appendChild(d);
      });
      // Clear players list
      el.lobbyPlayers.innerHTML = '';
      el.lobbyPlayers.appendChild(el.lobbyEmpty);
      el.lobbyEmpty.classList.remove('hidden');
      el.playerCount.textContent = '0 joined';
      el.startBtn.disabled = true;
      el.startBtn.classList.remove('btn-ready');
    } catch (err) {
      console.error('Reset PIN failed:', err);
    }
    el.resetPinBtn.disabled = false;
    el.resetPinBtn.textContent = '\u21bb New Code';
  });
}

// ── File / drag-drop handling ────────────────────────────────
el.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  el.dropZone.classList.add('drag-over');
});
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));
el.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  el.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file && (file.name.endsWith('.json') || file.name.endsWith('.questron'))) loadFile(file);
});

el.jsonFile.addEventListener('change', () => {
  const file = el.jsonFile.files[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  el.createMsg.textContent = '';
  imageMap.clear();
  try {
    if (file.name.endsWith('.questron')) {
      await loadQuestronFile(file);
    } else {
      const text = await file.text();
      payload = JSON.parse(text);
    }
    const qCount = payload.questions?.length || 0;
    const avgSec = payload.questions?.reduce((a, q) => a + (q.timeLimitSeconds || payload.defaultTimeLimitSeconds || 20), 0) / (qCount || 1);
    const estMin = Math.max(1, Math.round((qCount * (avgSec + 5)) / 60));
    el.previewTitle.textContent  = payload.title || 'Untitled Quiz';
    el.previewQCount.textContent = `${qCount} question${qCount !== 1 ? 's' : ''}`;
    el.previewTime.textContent   = `~${estMin} min`;
    const fileIcon = SUBJECT_ICON_MAP[payload.meta?.subject] || '\ud83d\udccb';
    if (el.selectedIcon) el.selectedIcon.textContent = fileIcon;
    if (el.settingShuffleQ) el.settingShuffleQ.checked = payload.shuffleQuestions !== false;
    el.quizPreview.classList.remove('hidden');
    el.createBtn.disabled = false;
  } catch (err) {
    el.createMsg.textContent = '[!] Could not load file — check format.';
    el.quizPreview.classList.add('hidden');
    el.createBtn.disabled = true;
  }
}

// ── Lazy-load JSZip on first .questron use ──────────────────
async function ensureJSZip() {
  if (typeof JSZip !== 'undefined') return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load JSZip'));
    document.head.appendChild(s);
  });
}

async function loadQuestronFile(file) {
  await ensureJSZip();
  const MAX_IMG = 700 * 1024; // 700 KB binary → ~933 KB base64, fits in 1 MB WS message
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  // ZIP bomb guard
  let totalUncompressed = 0;
  for (const entry of Object.values(zip.files)) {
    totalUncompressed += (entry._data?.uncompressedSize ?? 0);
    if (totalUncompressed > 20 * 1024 * 1024) throw new Error('File too large (> 20 MB uncompressed).');
  }

  const quizEntry = zip.file('quiz.json');
  if (!quizEntry) throw new Error('No quiz.json found in this .questron file.');
  payload = JSON.parse(await quizEntry.async('text'));

  // Extract images into imageMap with security validation
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!name.startsWith('images/') || entry.dir) continue;
    const filename = name.slice('images/'.length);
    // Path traversal guard
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) continue;
    const imgBuf = await entry.async('arraybuffer');
    if (imgBuf.byteLength > MAX_IMG) continue; // skip oversized
    const b = new Uint8Array(imgBuf.slice(0, 12));
    let mime = null;
    if (b[0]===0xFF && b[1]===0xD8) mime = 'image/jpeg';
    else if (b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47) mime = 'image/png';
    else if (b[0]===0x47 && b[1]===0x49 && b[2]===0x46) mime = 'image/gif';
    else if (b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46 &&
             b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50) mime = 'image/webp';
    if (!mime) continue; // skip unknown/unsafe formats (no SVG)
    const blob    = new Blob([imgBuf], { type: mime });
    const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    imageMap.set(filename, dataUrl);
  }
}

// ── Create game ───────────────────────────────────────────────

// ── Library browser ──────────────────────────────────────────
const LIBRARY_INDEX_URL = 'https://cdn.jsdelivr.net/gh/kylejckson/questron-library@main/index.json';
const SUBJECT_ICON_MAP = {
  'Geography':'\ud83c\udf0d','History':'\ud83d\udcdc','Science':'\ud83d\udd2c','Pop Culture':'\ud83c\udfac',
  'Sports':'\u26bd','Music':'\ud83c\udfb5','Food & Drink':'\ud83c\udf55','Technology':'\ud83d\udcbb',
  'Language':'\u270d\ufe0f','Art & Literature':'\ud83c\udfa8','Mathematics':'\ud83d\udd22',
  'General Knowledge':'\ud83e\udde0',
};
const DIFF_CLASS_MAP = { easy:'diff-easy', medium:'diff-medium', hard:'diff-hard' };

function buildCreatePayload() {
  if (!payload) return null;
  const p = JSON.parse(JSON.stringify(payload));
  p.shuffleQuestions = el.settingShuffleQ ? el.settingShuffleQ.checked : (payload.shuffleQuestions !== false);
  p.shuffleAnswers   = el.settingShuffleA ? el.settingShuffleA.checked : true;
  const tOverride = parseInt(el.settingTimeOverride?.value);
  if (!isNaN(tOverride) && tOverride >= 5) {
    p.defaultTimeLimitSeconds = tOverride;
    p.questions = (p.questions || []).map(q => ({ ...q, timeLimitSeconds: tOverride }));
  }
  return p;
}

function showSettings(quizData, icon) {
  payload = quizData;
  const qCount = payload.questions?.length || 0;
  const avgSec = (payload.questions?.reduce((a, q) => a + (q.timeLimitSeconds || payload.defaultTimeLimitSeconds || 20), 0) || 0) / (qCount || 1);
  const estMin = Math.max(1, Math.round((qCount * (avgSec + 5)) / 60));
  if (el.selectedIcon) el.selectedIcon.textContent = icon;
  el.previewTitle.textContent  = payload.title || 'Untitled Quiz';
  el.previewQCount.textContent = `${qCount} question${qCount !== 1 ? 's' : ''}`;
  el.previewTime.textContent   = `~${estMin} min`;
  if (el.settingShuffleQ) el.settingShuffleQ.checked = payload.shuffleQuestions !== false;
  el.quizPreview.classList.remove('hidden');
  el.createBtn.disabled = false;
  el.createMsg.textContent = '';
}

function renderHostGrid() {
  const grid = el.hostQuizGrid;
  if (!grid) return;
  const s = hostLibrarySearch;
  const filtered = hostLibraryAll.filter(q => {
    const sub  = (q.subject  || q.meta?.subject  || '').toLowerCase();
    const diff = (q.difficulty || q.meta?.difficulty || '').toLowerCase();
    const tags = (q.tags || q.meta?.tags || []).join(' ').toLowerCase();
    const text = `${q.title||''} ${q.meta?.description||''} ${sub} ${tags}`.toLowerCase();
    return (!hostLibrarySubject || sub === hostLibrarySubject.toLowerCase())
        && (!hostLibraryDiff    || diff === hostLibraryDiff)
        && (!s                  || text.includes(s));
  });
  if (!filtered.length) {
    grid.innerHTML = '<div class="library-empty" style="font-size:0.82rem;padding:var(--gap-lg) 0;">No quizzes matched your filters.</div>';
    return;
  }
  grid.innerHTML = filtered.map(q => {
    const subject = q.subject || q.meta?.subject || '';
    const diff    = q.difficulty || q.meta?.difficulty || '';
    const icon    = SUBJECT_ICON_MAP[subject] || '\ud83d\udccb';
    const qCount  = q.questionCount || '?';
    const mins    = q.estimatedMinutes || q.meta?.estimatedMinutes || null;
    const diffBadge = diff ? `<span class="diff-badge ${DIFF_CLASS_MAP[diff]||''}" style="font-size:0.62rem;padding:1px 5px;">${diff}</span>` : '';
    return `<div class="host-quiz-card" data-url="${escHtml(q.quizUrl||'')}" data-title="${escHtml(q.title||'')}" data-icon="${icon}" tabindex="0" role="button" aria-label="Select: ${escHtml(q.title||'')}"><div class="host-quiz-card__icon">${icon}</div><div class="host-quiz-card__title">${escHtml(q.title||'')}</div><div class="host-quiz-card__meta">${qCount} Q${mins?` \u00b7 ~${mins}m`:''}${diffBadge ? ' &nbsp;' + diffBadge : ''}</div></div>`;
  }).join('');
  grid.querySelectorAll('.host-quiz-card').forEach(card => {
    const pick = () => selectLibraryQuiz(card);
    card.addEventListener('click', pick);
    card.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') pick(); });
  });
}

async function selectLibraryQuiz(card) {
  const url = card.dataset.url;
  if (!url) return;
  el.createMsg.textContent = '';
  try {
    card.style.opacity = '0.6';
    const res  = await fetch(url);
    const data = await res.json();
    card.style.opacity = '';
    el.hostQuizGrid?.querySelectorAll('.host-quiz-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    showSettings(data, card.dataset.icon || '\ud83d\udccb');
  } catch {
    card.style.opacity = '';
    el.createMsg.textContent = '[!] Failed to load quiz from library.';
  }
}

async function loadHostLibrary() {
  if (!el.hostQuizGrid) return;
  const CACHE_KEY = 'qlib_' + LIBRARY_INDEX_URL.slice(-24);
  try {
    let data;
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) data = JSON.parse(cached);
    } catch {}
    if (!data) {
      const res = await fetch(LIBRARY_INDEX_URL);
      data = await res.json();
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
    }
    hostLibraryAll = Array.isArray(data.quizzes) ? data.quizzes : [];
    // Build subject chips
    const subjectSet = new Set();
    hostLibraryAll.forEach(q => { const s = q.subject || q.meta?.subject; if (s) subjectSet.add(s); });
    if (el.hostSubjectChips && subjectSet.size > 0) {
      const SUBJECT_VISIBLE = 8;
      const sortedSubjects = [...subjectSet].sort();
      sortedSubjects.slice(0, SUBJECT_VISIBLE).forEach(s => {
        const chip = document.createElement('button');
        chip.className    = 'filter-chip';
        chip.dataset.value = s;
        chip.textContent  = (SUBJECT_ICON_MAP[s] || '') + ' ' + s;
        el.hostSubjectChips.appendChild(chip);
      });
      if (sortedSubjects.length > SUBJECT_VISIBLE) {
        const moreWrap = document.createElement('div');
        moreWrap.className = 'subject-more-wrap';
        const moreBtn = document.createElement('button');
        moreBtn.className = 'filter-chip subject-more-btn';
        moreBtn.setAttribute('type', 'button');
        moreBtn.textContent = '+' + (sortedSubjects.length - SUBJECT_VISIBLE) + ' more ▾';
        const dropdown = document.createElement('div');
        dropdown.className = 'subject-more-dropdown';
        sortedSubjects.slice(SUBJECT_VISIBLE).forEach(s => {
          const chip = document.createElement('button');
          chip.className    = 'filter-chip';
          chip.dataset.value = s;
          chip.textContent  = (SUBJECT_ICON_MAP[s] || '') + ' ' + s;
          dropdown.appendChild(chip);
        });
        moreBtn.addEventListener('click', e => {
          e.stopPropagation();
          dropdown.classList.toggle('open');
        });
        document.addEventListener('click', () => dropdown.classList.remove('open'), { passive: true });
        moreWrap.appendChild(moreBtn);
        moreWrap.appendChild(dropdown);
        el.hostSubjectChips.appendChild(moreWrap);
      }
    }
    document.getElementById('hostLoadingMsg')?.remove();
    renderHostGrid();
  } catch {
    const msg = document.getElementById('hostLoadingMsg');
    if (msg) msg.textContent = 'Library unavailable. Upload a file below.';
  }
}

// Filter / search handlers
if (el.hostSubjectChips) {
  el.hostSubjectChips.addEventListener('click', e => {
    const chip = e.target.closest('.filter-chip');
    if (!chip || chip.classList.contains('subject-more-btn')) return;
    hostLibrarySubject = chip.dataset.value;
    // close dropdown
    el.hostSubjectChips.querySelector('.subject-more-dropdown')?.classList.remove('open');
    // update active states (exclude the more btn itself)
    el.hostSubjectChips.querySelectorAll('.filter-chip:not(.subject-more-btn)').forEach(c => c.classList.toggle('active', c.dataset.value === hostLibrarySubject));
    // highlight more btn when the active subject lives inside the dropdown
    const moreBtn = el.hostSubjectChips.querySelector('.subject-more-btn');
    if (moreBtn) {
      const inDropdown = [...el.hostSubjectChips.querySelectorAll('.subject-more-dropdown .filter-chip')].some(c => c.dataset.value === hostLibrarySubject);
      moreBtn.classList.toggle('active', inDropdown);
    }
    renderHostGrid();
  });
}
if (el.hostDiffChips) {
  el.hostDiffChips.addEventListener('click', e => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    hostLibraryDiff = chip.dataset.value;
    el.hostDiffChips.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.value === hostLibraryDiff));
    renderHostGrid();
  });
}
if (el.hostSearchInput) {
  el.hostSearchInput.addEventListener('input', () => {
    hostLibrarySearch = el.hostSearchInput.value.toLowerCase().trim();
    renderHostGrid();
  });
}

// Clear selected quiz
if (el.clearQuizBtn) {
  el.clearQuizBtn.addEventListener('click', () => {
    payload = null;
    el.quizPreview.classList.add('hidden');
    el.createBtn.disabled = true;
    el.createMsg.textContent = '';
    el.hostQuizGrid?.querySelectorAll('.host-quiz-card').forEach(c => c.classList.remove('selected'));
    if (el.jsonFile) el.jsonFile.value = '';
  });
}

// ── Create game ───────────────────────────────────────────────
el.createBtn.addEventListener('click', async () => {
  if (!payload) return;
  el.createBtn.disabled = true;
  el.createMsg.textContent = '';

  let data;
  try {
    const res = await fetch(`${GAME_SERVER_URL}/api/create`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(buildCreatePayload()),
    });
    data = await res.json();
  } catch (err) {
    el.createMsg.textContent = '[!] Cannot reach game server. Is it running?';
    el.createBtn.disabled = false;
    return;
  }

  if (!data.ok) {
    el.createMsg.textContent = data.error || 'Failed to create game.';
    el.createBtn.disabled = false;
    return;
  }

  gameId = data.gameId;
  hostSecret       = data.hostSecret || '';
  questionOrder    = data.questionOrder || [];
  hostCurrentIndex = -1;
  socket.connect(`${GAME_SERVER_WS}/room/${gameId}?role=host&secret=${encodeURIComponent(hostSecret)}`);

  // Render PIN as individual glowing chars
  el.gameId.innerHTML = '';
  String(gameId).split('').forEach((ch, i) => {
    const d = document.createElement('div');
    d.className = 'game-code-char';
    d.textContent = ch;
    d.style.setProperty('--char-i', i);
    setTimeout(() => d.classList.add('pop'), 80 + i * 120);
    el.gameId.appendChild(d);
  });
  el.lobbyTitle.textContent = payload.title || 'Quiz';
  const host = location.hostname + (location.port && location.port !== '80' ? ':' + location.port : '');
  const playerUrl = `${location.protocol}//${host}/player?game=${encodeURIComponent(gameId)}`;
  el.joinUrl.textContent = `${host}/join`;
  // Generate QR code
  if (typeof QRCode !== 'undefined') {
    const qrCanvas = el.qrCanvas || document.getElementById('qrCanvas');
    qrCanvas.innerHTML = '';
    new QRCode(qrCanvas, {
      text: playerUrl,
      width: 115, height: 115,
      colorDark: '#b8ff3c', colorLight: '#111111',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }
  showOnly(el.screenLobby);
  try{ if(localStorage.getItem('qDonDismiss')!=='1') document.getElementById('donateBanner').style.display='none'; }catch{}
});


// ── Pause / Resume ────────────────────────────────────────────
el.pauseBtn.addEventListener('click', () => {
  if (!gameId) return;
  if (!isPaused) {
    socket.emit('host:pause', { gameId });
  } else {
    socket.emit('host:resume', { gameId });
  }
});

socket.on('game:paused', ({ msRemaining }) => {
  isPaused = true;
  stopTimer?.();
  clearAutoAdvance(); // also cancels reveal auto-timer
  el.pauseBtn.textContent = 'Resume';
  el.pauseBtn.classList.add('paused');
  let banner = document.getElementById('pausedBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'pausedBanner';
    banner.className = 'paused-banner';
    banner.innerHTML = '<span class="paused-banner-inner">⏸ Game Paused · All timers stopped · ⏸ Game Paused · All timers stopped · </span>';
    document.body.prepend(banner);
  }
});

socket.on('game:resumed', ({ msRemaining }) => {
  isPaused = false;
  el.pauseBtn.textContent = 'Pause';
  el.pauseBtn.classList.remove('paused');
  document.getElementById('pausedBanner')?.remove();
  // Restart ring timer for remaining ms
  stopTimer = startTimerRing('hostTimerWrap', msRemaining / 1000);
});

// ── Emoji reactions (host display) ───────────────────────────
socket.on('reaction:received', ({ name, emoji }) => {
  showFloatingReaction(emoji, name);
});

// ── Lobby updates ─────────────────────────────────────────────
socket.on('lobby:update', ({ players, gameId: gid }) => {
  if (gameId && gid !== gameId) return;
  totalPlayers = players.length;

  el.playerCount.textContent = `${players.length} joined`;
  el.startBtn.disabled = players.length === 0;
  if (players.length > 0) {
    el.startBtn.classList.add('btn-ready');
  } else {
    el.startBtn.classList.remove('btn-ready');
  }

  if (players.length === 0) {
    el.lobbyEmpty.classList.remove('hidden');
    el.lobbyPlayers.innerHTML = '';
    el.lobbyPlayers.appendChild(el.lobbyEmpty);
    return;
  }
  el.lobbyEmpty.classList.add('hidden');

  // Diff: only add new chips
  const existing = new Set([...el.lobbyPlayers.querySelectorAll('.player-chip')]
    .map(c => c.dataset.name));
  players.forEach(name => {
    if (!existing.has(name)) {
      const chip = document.createElement('div');
      chip.className   = 'player-chip';
      chip.dataset.name = name;
      const dot = document.createElement('span');
      dot.className = 'player-chip-dot';
      dot.style.background = playerColor(name);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(name));
      // Kick button
      const kickBtn = document.createElement('button');
      kickBtn.className   = 'player-kick-btn';
      kickBtn.textContent = '\u2715';
      kickBtn.title       = `Remove ${name}`;
      kickBtn.addEventListener('click', e => {
        e.stopPropagation();
        socket.emit('host:kickPlayer', { gameId, playerName: name });
      });
      chip.appendChild(kickBtn);
      el.lobbyPlayers.appendChild(chip);
    }
  });
  // Remove chips for players that left
  el.lobbyPlayers.querySelectorAll('.player-chip').forEach(chip => {
    if (!players.includes(chip.dataset.name)) chip.remove();
  });
});

// ── Start game ────────────────────────────────────────────────
el.startBtn.addEventListener('click', () => {
  if (!gameId) return;
  socket.emit('host:startGame', { gameId, imageData: getImageData(0) });
});

socket.on('game:started', () => {
  showOnly(el.screenPlay);
});

// ── Question display ──────────────────────────────────────────
socket.on('question:show', (q) => {
  hostCurrentIndex = q.index;
  stopTimer?.();
  el.barChart.classList.add('hidden');
  el.nextBtn.classList.add('hidden');
  el.lbNextBtn.classList.add('hidden');
  el.screenLeaderboard.classList.add('hidden');
  el.screenPlay.classList.remove('hidden');

  // Progress
  const pct = ((q.index) / q.total) * 100;
  el.hostProgressBar.style.width = pct + '%';
  el.qIndex.textContent = q.index + 1;
  el.qTotal.textContent = q.total;
  el.qText.textContent  = q.text;

  if (q.imageData || q.imageUrl) {
    el.qImage.src = q.imageData || q.imageUrl;
    el.qImage.classList.remove('hidden');
    el.qImage.onerror = () => el.qImage.classList.add('hidden');
  } else {
    el.qImage.classList.add('hidden');
  }

  // Build answer buttons
  el.answers.innerHTML = '';
  optionIdOrder = q.options.map(opt => opt.id);
  q.options.forEach((opt, idx) => {
    const s = ANSWER_STYLES[idx % ANSWER_STYLES.length];
    const btn = document.createElement('button');
    btn.className = `answer ${s.color}`;
    btn.disabled  = true;
    btn.dataset.id = opt.id;
    btn.innerHTML =
      `<span class="answer-fill-bar"></span>` +
      `<span class="shape">${s.shape}</span>` +
      `<span class="label">${escHtml(opt.label)}</span>` +
      `<span class="answer-icon">✓</span>`;
    el.answers.appendChild(btn);
  });

  // Answered counter
  el.answeredCounter.style.display = 'flex';
  el.answeredFill.style.width = '0%';
  el.answeredText.textContent = `0 / ${totalPlayers} answered`;

  // Timer ring
  stopTimer = startTimerRing('hostTimerWrap', q.timeLimitSeconds);

  // Music
  try { el.music.currentTime = 0; el.music.play(); } catch {}
});

// ── Live answer progress ──────────────────────────────────────
socket.on('round:progress', ({ answeredCount, totalCount }) => {
  totalPlayers = totalCount;
  const pct = totalCount > 0 ? (answeredCount / totalCount) * 100 : 0;
  el.answeredFill.style.width = pct + '%';
  el.answeredText.textContent = `${answeredCount} / ${totalCount} answered`;

  // Update fill bars on each answer button
  [...el.answers.children].forEach(btn => {
    btn.style.setProperty('--fill', String(pct));
    const bar = btn.querySelector('.answer-fill-bar');
    if (bar) bar.style.width = pct + '%';
  });
});

// ── Answer reveal ─────────────────────────────────────────────
socket.on('question:reveal', ({ correctOptionIds, leaderboard, counts, playerChoices, percentCorrect, fastestName }) => {
  stopTimer?.();
  clearAutoAdvance();
  try { el.music.pause(); } catch {}
  try { el.reveal.currentTime = 0; el.reveal.play(); } catch {}

  // If the round ended while paused (e.g. all players answered), clear the paused UI
  if (isPaused) {
    isPaused = false;
    el.pauseBtn.textContent = 'Pause';
    el.pauseBtn.classList.remove('paused');
    document.getElementById('pausedBanner')?.remove();
  }

  const maxCount = Math.max(1, ...(counts || [0]));

  // Highlight answers with flip
  [...el.answers.children].forEach((btn, idx) => {
    const optId = btn.dataset.id;
    btn.style.setProperty('--fill', '0');
    const resultClass = correctOptionIds.includes(optId) ? 'correct' : 'wrong';
    flipRevealCard(btn, resultClass, idx * 75);

    // After flip: inject shame names on wrong cards
    if (resultClass === 'wrong') {
      const names = playerChoices?.[optId] ?? [];
      if (names.length > 0) {
        setTimeout(() => {
          if (!btn.isConnected) return;
          btn.style.overflow = 'visible';
          const shameDiv = document.createElement('div');
          shameDiv.className = 'shame-names';
          names.forEach((name, ni) => {
            const chip = document.createElement('span');
            chip.className = 'shame-chip';
            chip.textContent = name;
            chip.style.animationDelay = (ni * 60) + 'ms';
            shameDiv.appendChild(chip);
          });
          btn.appendChild(shameDiv);
          // Trigger transition on next frame
          requestAnimationFrame(() => requestAnimationFrame(() =>
            shameDiv.classList.add('visible')
          ));
        }, idx * 75 + 380);
      }
    }

    // Count badge (added after flip completes so it's visible on the new face)
    const count = optionIdOrder[idx] !== undefined ? (counts?.[idx] ?? 0) : 0;
    setTimeout(() => {
      const badge = document.createElement('span');
      badge.className = 'answer-count';
      badge.textContent = count;
      btn.appendChild(badge);
    }, idx * 75 + 340);
  });

  // Bar chart
  el.barChart.innerHTML = '';
  el.barChart.classList.remove('hidden');
  counts?.forEach((count, idx) => {
    const s   = ANSWER_STYLES[idx % ANSWER_STYLES.length];
    const pct = Math.round((count / maxCount) * 100);
    el.barChart.innerHTML +=
      `<div class="bar-item">
        <div class="bar-fill ${s.color}" style="height:${pct}%"></div>
        <span class="bar-count">${count}</span>
      </div>`;
  });

  // Leaderboard (built now, shown later when host clicks Next)
  el.board.innerHTML = buildRaceLeaderboard(leaderboard, prevLeaderboard);
  prevLeaderboard = [...leaderboard];

  // Review stats
  el.reviewStats.innerHTML = `
    <div class="review-stat">
      <div class="review-stat-value">${percentCorrect ?? '—'}%</div>
      <div class="review-stat-label">Got it right</div>
    </div>
    ${fastestName ? `
    <div class="review-stat">
      <div class="review-stat-value" style="font-size:1rem;">${escHtml(fastestName)}</div>
      <div class="review-stat-label">Fastest correct</div>
    </div>` : ''}`;
  el.reviewStats.classList.remove('hidden');
  // Don't show screenLeaderboard yet — host must click Next → first
});

// Returns the configured auto-delay (seconds) for a given setting input,
// clamped to a valid range. Returns 0 if the user set it to 0 (manual only).
function getAutoDelaySecs(inputEl, defaultVal, min, max) {
  if (!inputEl) return defaultVal;
  const v = parseInt(inputEl.value);
  if (isNaN(v)) return defaultVal;
  return Math.max(min, Math.min(max, v));
}

// ── Can advance ───────────────────────────────────────────────
function clearAutoAdvance() {
  if (autoAdvanceTimer) {
    clearInterval(autoAdvanceTimer);
    autoAdvanceTimer = null;
  }
  if (revealAutoTimer) {
    clearTimeout(revealAutoTimer);
    if (revealCountdownInterval) { clearInterval(revealCountdownInterval); revealCountdownInterval = null; }
    revealAutoTimer = null;
  }
  el.autoAdvanceWrap.classList.add('hidden');
  el.revealAutoWrap?.classList.add('hidden');
}

socket.on('host:canAdvance', () => {
  // Show 'Next →' on the play screen only — leaderboard comes after
  el.nextBtn.classList.remove('hidden');
  // Auto-show leaderboard after configured delay (0 = manual only)
  const revealSecs = getAutoDelaySecs(el.settingRevealSecs, 10, 0, 30);
  if (!isPaused && revealSecs > 0) {
    let secsLeft = revealSecs;
    el.revealAutoSec.textContent = secsLeft;
    el.revealAutoFill.style.transition = 'none';
    el.revealAutoFill.style.width = '100%';
    el.revealAutoWrap.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.revealAutoFill.style.transition = `width ${secsLeft}s linear`;
      el.revealAutoFill.style.width = '0%';
    }));
    revealCountdownInterval = setInterval(() => {
      secsLeft--;
      el.revealAutoSec.textContent = secsLeft;
    }, 1000);
    revealAutoTimer = setTimeout(() => {
      clearInterval(revealCountdownInterval); revealCountdownInterval = null;
      revealAutoTimer = null;
      el.revealAutoWrap.classList.add('hidden');
      showLeaderboard();
    }, revealSecs * 1000);
  }
});

function showLeaderboard() {
  // Cancel the 10s reveal auto-timer if host clicked manually
  if (revealAutoTimer) { clearTimeout(revealAutoTimer); revealAutoTimer = null; }
  if (revealCountdownInterval) { clearInterval(revealCountdownInterval); revealCountdownInterval = null; }
  el.revealAutoWrap.classList.add('hidden');
  // Switch from play screen to the leaderboard screen
  el.nextBtn.classList.add('hidden');
  showOnly(el.screenLeaderboard);
  el.lbNextBtn.classList.remove('hidden');

  // Don't auto-advance while paused
  if (isPaused) return;

  // Auto-advance countdown (0 = manual only)
  const lbSecs = getAutoDelaySecs(el.settingLbSecs, 8, 0, 30);
  if (lbSecs <= 0) return;

  let secsLeft = lbSecs;
  el.autoAdvanceSec.textContent = secsLeft;
  el.autoAdvanceFill.style.transition = 'none';
  el.autoAdvanceFill.style.width = '100%';
  el.autoAdvanceWrap.classList.remove('hidden');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.autoAdvanceFill.style.transition = `width ${secsLeft}s linear`;
    el.autoAdvanceFill.style.width = '0%';
  }));

  autoAdvanceTimer = setInterval(() => {
    secsLeft--;
    el.autoAdvanceSec.textContent = secsLeft;
    if (secsLeft <= 0) {
      clearAutoAdvance();
      advanceQuestion();
    }
  }, 1000);
}

function advanceQuestion() {
  clearAutoAdvance();
  el.nextBtn.classList.add('hidden');
  el.lbNextBtn.classList.add('hidden');
  el.reviewStats.classList.add('hidden');
  socket.emit('host:next', { gameId, imageData: getImageData(hostCurrentIndex + 1) });
}

el.autoAdvanceCancelBtn.addEventListener('click', () => {
  clearAutoAdvance();
});

if (el.revealAutoCancelBtn) {
  el.revealAutoCancelBtn.addEventListener('click', () => {
    if (revealAutoTimer) { clearTimeout(revealAutoTimer); revealAutoTimer = null; }
    if (revealCountdownInterval) { clearInterval(revealCountdownInterval); revealCountdownInterval = null; }
    el.revealAutoWrap.classList.add('hidden');
  });
}

el.nextBtn.addEventListener('click', showLeaderboard);
el.lbNextBtn.addEventListener('click', advanceQuestion);

// ── Game over ─────────────────────────────────────────────────
socket.on('game:over', ({ leaderboard }) => {
  stopTimer?.();
  el.podiumWrap.innerHTML  = buildPodium(leaderboard);
  el.finalBoard.innerHTML  = buildLeaderboard(leaderboard);
  showOnly(el.screenOver);
  try { el.end.currentTime = 0; el.end.play(); } catch {}
  launchConfetti();
});

// ── Cancelled ─────────────────────────────────────────────────
socket.on('game:cancelled', ({ reason }) => {
  el.cancelReason.textContent = reason || 'Game ended.';
  showOnly(el.screenCancelled);
});

// ── Back to create ────────────────────────────────────────────
el.backToCreateBtn.addEventListener('click', () => {
  gameId   = null;
  payload  = null;
  isPaused = false;
  clearAutoAdvance();
  stopTimer?.();
  document.getElementById('pausedBanner')?.remove();
  el.jsonFile.value          = '';
  el.createMsg.textContent   = '';
  el.createBtn.disabled      = true;
  el.quizPreview.classList.add('hidden');
  // Deselect any library card
  el.hostQuizGrid?.querySelectorAll('.host-quiz-card').forEach(c => c.classList.remove('selected'));
  el.lobbyPlayers.innerHTML  = '';
  // Restore donate banner if not permanently dismissed
  try{ if(localStorage.getItem('qDonDismiss')!=='1'){ const b=document.getElementById('donateBanner'); if(b) b.style.display=''; } }catch{}
  el.lobbyPlayers.appendChild(el.lobbyEmpty);
  el.board.innerHTML         = '';
  el.finalBoard.innerHTML    = '';
  prevLeaderboard = [];
  showOnly(el.screenCreate);
});

// ── Load quiz payload from library (via sessionStorage) ───────
(function () {
  const stored = sessionStorage.getItem('questron_quiz_payload');
  if (stored && new URLSearchParams(location.search).has('from')) {
    if (location.search) history.replaceState(null, '', location.pathname);
    try {
      const parsed = JSON.parse(stored);
      sessionStorage.removeItem('questron_quiz_payload');
      const icon = SUBJECT_ICON_MAP[parsed.meta?.subject] || '\ud83d\udccb';
      showSettings(parsed, icon);
    } catch { /* ignore malformed payload */ }
  }
})();

// Load library — defer until browser is idle so first paint isn't blocked
if ('requestIdleCallback' in window) {
  requestIdleCallback(() => loadHostLibrary(), { timeout: 1000 });
} else {
  setTimeout(loadHostLibrary, 100);
}