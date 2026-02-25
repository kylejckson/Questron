// public/player.js
const socket = createSocket();
const $  = id => document.getElementById(id);

// ── Sound toggle ─────────────────────────────────────────────
const sound = initSoundToggle();

// ── Element refs ─────────────────────────────────────────────
const el = {
  screenJoin:        $('screenJoin'),
  screenWaiting:     $('screenWaiting'),
  screenPlay:        $('screenPlay'),
  screenLeaderboard: $('screenLeaderboard'),
  screenOver:        $('screenOver'),

  joinGameBadge:     $('joinGameBadge'),
  nameInput:         $('nameInput'),
  joinBtn:           $('joinBtn'),
  joinMsg:           $('joinMsg'),

  waitingName:       $('waitingName'),
  waitingHeading:    $('waitingHeading'),
  waitingGameTitle:  $('waitingGameTitle'),

  qText:             $('qText'),
  qImage:            $('qImage'),
  qIndex:            $('qIndex'),
  qTotal:            $('qTotal'),
  answers:           $('answers'),
  playerProgressBar: $('playerProgressBar'),
  lockedState:       $('lockedState'),
  lockedChoiceLabel: $('lockedChoiceLabel'),
  feedbackPanel:     $('feedbackPanel'),
  feedbackIcon:      $('feedbackIcon'),
  feedbackDelta:     $('feedbackDelta'),
  feedbackLabel:     $('feedbackLabel'),
  feedbackStreak:    $('feedbackStreak'),
  rankBadge:         $('rankBadge'),
  reactionBar:       $('reactionBar'),
  music:             $('music'),
  revealAudio:       $('revealAudio'),

  board:             $('board'),
  podiumWrap:        $('podiumWrap'),
  finalBoard:        $('finalBoard'),
  backToJoinBtn:     $('backToJoinBtn'),
  endAudio:          $('endAudio'),
};

// ── State ─────────────────────────────────────────────────────
const params          = new URLSearchParams(location.search);
const gameId          = params.get('game');
const nameFromJoin    = params.get('name');  // passed from join.html
let   myName          = nameFromJoin || '';
let   currentQId      = null;
let   lockedOptionId  = null;
let   stopTimer       = null;
let   myRank          = null;
let   prevLeaderboard = [];
let   wasKicked       = false;  // prevents auto-rejoin after being removed
let   rejoinToken     = null;

// ── Screen management ─────────────────────────────────────────
function showOnly(screenEl) {
  [el.screenJoin, el.screenWaiting, el.screenPlay,
   el.screenLeaderboard, el.screenOver]
    .forEach(s => s.classList.add('hidden'));
  screenEl.classList.remove('hidden');
}
// ── Rejoin / sessionStorage ────────────────────────────────────────
function saveSession(gId, name) {
  try { sessionStorage.setItem('nq_session', JSON.stringify({ gameId: gId, name, rejoinToken })); } catch {}
}
function clearSession() {
  try { sessionStorage.removeItem('nq_session'); } catch {}
}
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem('nq_session') || 'null'); } catch { return null; }
}
// Restore rejoin token from previous session (survives page refresh)
const _savedSession = loadSession();
if (_savedSession && _savedSession.gameId === gameId && _savedSession.rejoinToken) {
  rejoinToken = _savedSession.rejoinToken;
}

// On reconnect, try to rejoin automatically
socket.on('connect', () => {
  if (wasKicked) return;  // don't auto-rejoin after being kicked
  if (myName && gameId) {
    socket.emit('player:join', { gameId, name: myName, rejoinToken }, (res) => {
      if (!res?.ok) {
        el.joinMsg.textContent = res?.error || 'Unable to join.';
        el.joinBtn.disabled = false;
        showOnly(el.screenJoin);
        return;
      }
      if (res.reconnected) {
        el.waitingHeading && (el.waitingHeading.textContent = "You're back!");
      }
      if (res.rejoinToken) rejoinToken = res.rejoinToken;
      saveSession(gameId, myName);
      el.waitingName.textContent = myName;
      el.waitingGameTitle.textContent = res.title
        ? `"${res.title}"${res.questionCount ? ` · ${res.questionCount} questions` : ''}`
        : '';
      showOnly(el.screenWaiting);
    });
  }
});
// ── Pre-fill from URL params ──────────────────────────────────
if (gameId) {
  el.joinGameBadge.textContent = `ROOM · ${gameId}`;
}
if (nameFromJoin) {
  el.nameInput.value = nameFromJoin;
  // Came from join.html with name already provided — skip straight to waiting
    if (gameId) {
      el.waitingName.textContent = nameFromJoin;
      showOnly(el.screenWaiting);
    }
} else if (gameId) {
  // Direct URL with game ID but no name — show name entry screen
  showOnly(el.screenJoin);
}

// ── Join flow ─────────────────────────────────────────────────
el.nameInput.addEventListener('input', () => { el.joinMsg.textContent = ''; });
el.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') el.joinBtn.click(); });

el.joinBtn.addEventListener('click', () => {
  const name = el.nameInput.value.trim();
  if (!name) {
    el.joinMsg.textContent = 'Please enter a name.';
    return;
  }
  if (!gameId) {
    el.joinMsg.textContent = 'No room code found — go back to join page.';
    return;
  }
  el.joinBtn.disabled = true;
  socket.emit('player:join', { gameId, name, rejoinToken }, (res) => {
    if (!res?.ok) {
      el.joinMsg.textContent = res?.error || 'Unable to join.';
      el.joinBtn.disabled = false;
      return;
    }
    myName = name;
    if (res.rejoinToken) rejoinToken = res.rejoinToken;
    saveSession(gameId, name);
    el.waitingName.textContent   = name;
    el.waitingGameTitle.textContent = res.title
      ? `"${res.title}"${res.questionCount ? ` · ${res.questionCount} questions` : ''}`
      : '';
    showOnly(el.screenWaiting);
  });
});

// ── Game started ──────────────────────────────────────────────
socket.on('game:started', () => {
  showOnly(el.screenPlay);
});

// ── Question display ──────────────────────────────────────────
socket.on('question:show', (q) => {
  stopTimer?.();
  currentQId   = q.id;
  lockedOptionId = null;

  // Progress bar
  const pct = ((q.index) / q.total) * 100;
  el.playerProgressBar.style.width = pct + '%';
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

  // Reset rank badge (will update after next leaderboard)
  el.rankBadge.style.display = 'none';
  if (myRank !== null) {
    el.rankBadge.textContent = myRank <= 3 ? ['#01','#02','#03'][myRank - 1] : `#${String(myRank).padStart(2,'0')}`;
    el.rankBadge.className  = `rank-badge${myRank <= 3 ? ' rank-top' : ''}`;
    el.rankBadge.style.display = 'inline-flex';
  }

  el.reactionBar.style.display = 'flex';

  // Reset feedback + locked
  el.lockedState.classList.add('hidden');
  el.feedbackPanel.classList.add('hidden');
  if (el.feedbackStreak) el.feedbackStreak.classList.add('hidden');
  el.answers.classList.remove('hidden');

  // Build answer buttons
  el.answers.innerHTML = '';
  q.options.forEach((opt, idx) => {
    const s = ANSWER_STYLES[idx % ANSWER_STYLES.length];
    const btn = document.createElement('button');
    btn.className  = `answer ${s.color}`;
    btn.dataset.id = opt.id;
    btn.innerHTML  =
      `<span class="answer-fill-bar"></span>` +
      `<span class="shape">${s.shape}</span>` +
      `<span class="label">${escHtml(opt.label)}</span>` +
      `<span class="answer-icon"></span>`;

    btn.addEventListener('click', () => {
      if (lockedOptionId) return;
      selectAnswer(q.id, opt.id, opt.label, s.color);
    });

    // 3D tilt
    btn.addEventListener('mousemove', e => {
      if (lockedOptionId) return;
      const r = btn.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width  - 0.5;
      const y = (e.clientY - r.top)  / r.height - 0.5;
      btn.style.setProperty('--ry', ( x * 14) + 'deg');
      btn.style.setProperty('--rx', (-y * 10) + 'deg');
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.setProperty('--rx', '0deg');
      btn.style.setProperty('--ry', '0deg');
    });

    el.answers.appendChild(btn);
  });

  showOnly(el.screenPlay);

  // Timer
  stopTimer = startTimerRing('playerTimerWrap', q.timeLimitSeconds);

  // Music
  try { el.music.currentTime = 0; el.music.play(); } catch {}
});

// ── Player selects answer ─────────────────────────────────────
function selectAnswer(qId, optionId, optionLabel, colorClass) {
  lockedOptionId = optionId;

  // Disable all, mark locked
  [...el.answers.children].forEach(btn => {
    btn.disabled = true;
    if (btn.dataset.id === optionId) btn.classList.add('locked');
    else btn.style.opacity = '0.4';
  });

  // Show locked overlay
  el.lockedChoiceLabel.textContent = optionLabel;
  el.lockedChoiceLabel.style.background = `var(--${colorClass.replace('opt-', 'opt-')})`
    + '-dim)'.replace('--opt-a-dim)', '') ;  // just use class
  el.lockedChoiceLabel.className = `locked-badge answer ${colorClass}`;
  el.lockedChoiceLabel.style.cssText = ''; // clear inline
  el.lockedState.classList.remove('hidden');
  el.answers.classList.add('hidden');

  socket.emit('player:answer', { gameId, questionId: qId, optionId });
}

// ── Server confirm locked ─────────────────────────────────────
socket.on('player:locked', () => {
  // Already handled UI-side, no action needed
});

// ── Game paused / resumed ─────────────────────────────────────
socket.on('game:paused', () => {
  stopTimer?.();
  // Disable answer buttons so players can't submit while paused
  if (!lockedOptionId) {
    [...el.answers.children].forEach(btn => btn.disabled = true);
  }
  // Show pause banner
  if (!document.getElementById('playerPauseBanner')) {
    const banner = document.createElement('div');
    banner.id = 'playerPauseBanner';
    banner.className = 'paused-banner';
    banner.innerHTML = '<span class="paused-banner-inner">⏸ Game Paused · Timers stopped · ⏸ Game Paused · Timers stopped · </span>';
    document.body.prepend(banner);
  }
});

socket.on('game:resumed', ({ msRemaining }) => {
  document.getElementById('playerPauseBanner')?.remove();
  if (!lockedOptionId) {
    [...el.answers.children].forEach(btn => btn.disabled = false);
    stopTimer = startTimerRing('playerTimerWrap', msRemaining / 1000);
  }
});

// ── Question reveal ───────────────────────────────────────────
socket.on('question:reveal', ({ correctOptionIds, leaderboard, counts }) => {
  stopTimer?.();
  document.getElementById('playerPauseBanner')?.remove();
  try { el.music.pause(); } catch {}
  try { el.revealAudio.currentTime = 0; el.revealAudio.play(); } catch {}

  const correctIds = (correctOptionIds || []).map(String);
  const lockedId   = lockedOptionId ? String(lockedOptionId) : null;
  const gotCorrect = lockedId && correctIds.includes(lockedId);
  const answered   = !!lockedId;

  // Show answers for reveal
  el.answers.classList.remove('hidden');
  el.lockedState.classList.add('hidden');

  // Style each button
  const allBtns = [...el.answers.children];
  const optOrder = allBtns.map(b => b.dataset.id);
  const countMap = {};
  optOrder.forEach((id, i) => { countMap[id] = counts?.[i] || 0; });

  allBtns.forEach((btn, idx) => {
    const optId = String(btn.dataset.id);
    const isCorrect = correctIds.includes(optId);
    const isLocked  = optId === lockedId;
    btn.disabled = true;

    // Count badge added after flip completes
    setTimeout(() => {
      const badge = document.createElement('span');
      badge.className = 'answer-count';
      badge.textContent = countMap[optId] ?? 0;
      btn.appendChild(badge);
    }, idx * 75 + 340);

    if (isCorrect) {
      if (answered && isLocked) {
        flipRevealCard(btn, 'player-correct', idx * 75);
        setTimeout(() => triggerParticleBurst(btn), idx * 75 + 340);
      } else {
        flipRevealCard(btn, 'player-reveal-correct', idx * 75);
      }
    } else {
      const wrongClass = (isLocked && !isCorrect) ? 'player-wrong' : 'wrong';
      flipRevealCard(btn, wrongClass, idx * 75);
    }
  });

  // Feedback panel
  el.feedbackPanel.classList.remove('hidden');
  if (el.feedbackStreak) el.feedbackStreak.classList.add('hidden');
  if (!answered) {
    el.feedbackIcon.textContent  = '⏱';
    el.feedbackDelta.textContent = '';
    el.feedbackLabel.textContent = 'Too slow!';
    el.feedbackLabel.style.color = 'var(--text-subtle)';
  } else if (gotCorrect) {
    el.feedbackIcon.textContent  = '✓';
    el.feedbackIcon.style.color  = 'var(--green)';
    el.feedbackLabel.textContent = 'Correct!';
    el.feedbackLabel.style.color = 'var(--green)';
    // Delta will be shown when leaderboard arrives (find self)
    const self = leaderboard.find(p => p.name === myName);
    if (self?.delta > 0) {
      el.feedbackDelta.textContent = `+${self.delta.toLocaleString()}`;
      el.feedbackDelta.style.color = 'var(--green)';
    }
    // Streak indicator
    if (el.feedbackStreak) {
      const streak = self?.streak || 0;
      if (streak >= 2) {
        el.feedbackStreak.textContent = `\ud83d\udd25 ${streak} Streak!`;
        el.feedbackStreak.classList.remove('hidden');
      } else {
        el.feedbackStreak.classList.add('hidden');
      }
    }
  } else {
    el.feedbackIcon.textContent  = '\u2717';
    el.feedbackIcon.style.color  = 'var(--red)';
    el.feedbackLabel.textContent = 'Wrong!';
    el.feedbackLabel.style.color = 'var(--red)';
    el.feedbackDelta.textContent = '';
    if (el.feedbackStreak) el.feedbackStreak.classList.add('hidden');
  }

  // Update leaderboard + rank
  el.board.innerHTML = buildRaceLeaderboard(leaderboard, prevLeaderboard, myName);
  prevLeaderboard = [...leaderboard];
  const selfEntry = leaderboard.findIndex(p => p.name === myName);
  if (selfEntry >= 0) myRank = selfEntry + 1;
  el.screenLeaderboard.classList.remove('hidden');
});

// ── Game over ─────────────────────────────────────────────────
socket.on('game:over', ({ leaderboard }) => {
  stopTimer?.();
  clearSession();
  el.podiumWrap.innerHTML = buildPodium(leaderboard);
  el.finalBoard.innerHTML = buildLeaderboard(leaderboard, myName);
  showOnly(el.screenOver);
  try { el.endAudio.currentTime = 0; el.endAudio.play(); } catch {}
  // Confetti if in top 3
  const rank = leaderboard.findIndex(p => p.name === myName);
  if (rank >= 0 && rank < 3) launchConfetti();
});

// ── Cancelled ─────────────────────────────────────────────────
socket.on('game:cancelled', () => {
  showOnly(el.screenJoin);
  el.joinMsg.textContent = 'Game was cancelled by the host.';
  el.joinBtn.disabled = false;
});

// ── Kicked by host ────────────────────────────────────────────
socket.on('player:kicked', () => {
  wasKicked = true;
  myName = '';  // clear identity so connect handler won't auto-rejoin
  showOnly(el.screenJoin);
  el.joinMsg.textContent = 'You were removed from the game by the host.';
  el.joinBtn.disabled = false;
});

// ── Reaction buttons ─────────────────────────────────────────
el.reactionBar.addEventListener('click', e => {
  const btn = e.target.closest('.reaction-btn');
  if (!btn || !gameId) return;
  const emoji = btn.dataset.emoji;
  if (!emoji) return;
  socket.emit('player:react', { gameId, emoji });
  // Brief visual feedback
  btn.classList.add('reacted');
  setTimeout(() => btn.classList.remove('reacted'), 600);
});

// ── Back to join ──────────────────────────────────────────────
el.backToJoinBtn.addEventListener('click', () => {
  window.location.href = '/join';
});

// ── Connect to game server ───────────────────────────────────
// Must be called AFTER all .on() listeners are registered so the
// 'connect' event (which fires on WS open) sees them all.
if (gameId) {
  const role = 'player';
  socket.connect(`${GAME_SERVER_WS}/room/${encodeURIComponent(gameId)}?role=${role}`);
} else {
  // No game ID in URL — send back to join page
  window.location.replace('/join');
}
