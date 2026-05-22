/* =====================================================
   SLACKADEMICS — Renderer (Rulebook v2)
   Idempotent DOM writers using actual card artwork.
   ===================================================== */
'use strict';

import { EFFORT_IMGS, totalFails } from './state.js';

// ── Card image base paths ─────────────────────────────────
const EFFORT_BASE    = './cards/effort/';
const LEADERSHIP_BASE = '../CARDS/Leadership Cards/';
const OTHER_BASE     = '../CARDS/Other Cards/';

// ── Module-level state ────────────────────────────────────
let _projectTarget = 20;   // updated from state on every renderGameHeader
let _cardClickCb   = null; // set by main.js for one-click card play

/** Set the callback invoked when human clicks a card in their hand.
 *  Signature: onCardClick(partyCardId, projectCardId) */
export function setCardClickCallback(fn) { _cardClickCb = fn; }

// ── Phase display ─────────────────────────────────────────
const PHASE_LABEL = {
  PLAYING:    'Playing Cards',
  REVEAL:     'Reveal',
  DEADLINE:   'Day of Deadline',
  BLAME:      'Blame Phase',
  BLAME_VOTE: 'Voting',
  SNITCH:     'Snitch Phase',
  BREAK:      'Semester Break',
  BREAK_DRAW: 'Draw New Pair',
  GAMEOVER:   'Game Over',
};

const PHASE_SUB = {
  PLAYING:    'Playing',
  REVEAL:     'Revealing',
  DEADLINE:   'Deadline',
  BLAME:      'Blaming',
  BLAME_VOTE: 'Voting',
  SNITCH:     'Snitching',
  BREAK:      'Break',
  BREAK_DRAW: 'Drawing',
  GAMEOVER:   'Game Over',
};

const PILE_ROTS = [-4, 3, -2, 5, -1, 2, -3, 4, -5, 1, -6, 3, 2, -4];

// ── Helpers ───────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function initials(name) {
  const w = String(name).trim().split(/\s+/);
  return (w.length >= 2
    ? w[0][0] + w[w.length - 1][0]
    : String(name).slice(0, 2)
  ).toUpperCase();
}

function failPipsHTML(count, limit = 5) {
  let html = '';
  for (let i = 0; i < limit; i++) {
    html += `<div class="fail-pip${i < count ? ' filled' : ''}"></div>`;
  }
  return html;
}

const $ = id => document.getElementById(id);

// ── Build effort card HTML — clean card photo, no overlay ──
function effortCardHTML(card) {
  const name    = esc(card.name ?? (card.type === 'copy' ? 'X2 Copy' : `Effort ${card.value}`));
  const imgFile = EFFORT_IMGS[card.value] ?? 'Effort 4.jpg';
  const imgSrc  = EFFORT_BASE + imgFile;
  // Just the physical card artwork, full-bleed inside the card border
  return `<img src="${imgSrc}" alt="${name}" `
       + `style="width:100%;height:100%;object-fit:cover;display:block;" />`;
}

export function buildEffortCardHTML(card) { return effortCardHTML(card); }

// ─────────────────────────────────────────────────────────
//  GAME HEADER
// ── Effort bar helper (drives the prominent bar row in header) ──
function _updateEffortBar(total, hidden) {
  const fill = $('effort-bar-fill');
  const cur  = $('effort-bar-current');
  const tgt  = $('effort-bar-target');
  if (tgt) tgt.textContent = _projectTarget;
  if (hidden) {
    if (fill) { fill.style.width = '0%'; fill.classList.remove('over-target'); }
    if (cur)  cur.textContent = '?';
    return;
  }
  if (cur)  cur.textContent = total;
  if (fill) {
    const pct = _projectTarget > 0 ? Math.min(total / _projectTarget * 100, 100) : 0;
    fill.style.width = pct + '%';
    fill.classList.toggle('over-target', total > _projectTarget);
  }
}

export function renderGameHeader(state) {
  _projectTarget = state.projectTarget;

  const roundLbl = document.querySelector('.round-lbl');
  if (roundLbl) roundLbl.textContent = `Semester ${state.semester} / ${state.totalSemesters}`;

  const badge = $('phase-badge');
  if (badge) {
    badge.textContent   = PHASE_LABEL[state.phase] ?? state.phase;
    badge.dataset.phase = state.phase;
  }

  const turnName = $('turn-name');
  const turnSub  = document.querySelector('.turn-sub');
  const activePl = state.activePlayerId ? state.players[state.activePlayerId] : null;
  if (turnName) turnName.textContent = activePl ? esc(activePl.name) : '—';
  if (turnSub)  turnSub.textContent  = PHASE_SUB[state.phase] ?? state.phase;

  // Hidden effort-pip span (kept for animQueue compat)
  const pip    = $('effort-pip');
  const pipVal = $('effort-val');
  const isPlaying = state.phase === 'PLAYING';
  if (pip)    pip.classList.toggle('unknown', isPlaying);
  if (pipVal) pipVal.textContent = isPlaying ? '?' : String(
    state.projectPile.reduce((s, c) => s + (c.revealed && c.type === 'effort' ? c.value : 0), 0)
  );

  // Prominent effort bar
  if (isPlaying) {
    _updateEffortBar(0, true);
  } else {
    const total = state.projectPile.reduce(
      (s, c) => s + (c.revealed && c.type === 'effort' ? c.value : 0), 0
    );
    _updateEffortBar(total, false);
  }

  const tgt = document.querySelector('.pile-target strong');
  if (tgt) tgt.textContent = state.projectTarget;

  const pool = document.querySelector('.pool-badge strong');
  if (pool) pool.textContent = state.effortPool.length;

  const semName = document.querySelector('.semester-name');
  if (semName) semName.textContent = state.semesterName ?? '';
}

export function renderEffortCounter(total) {
  const pip    = $('effort-pip');
  const pipVal = $('effort-val');
  if (pip)    pip.classList.remove('unknown');
  if (pipVal) pipVal.textContent = total;
  _updateEffortBar(total, false);
}

// ─────────────────────────────────────────────────────────
//  PROJECT PILE
// ─────────────────────────────────────────────────────────
export function renderProjectPile(state) {
  const container = $('project-pile');
  if (!container) return;
  container.innerHTML = '';

  state.projectPile.forEach((card, i) => {
    const rot = PILE_ROTS[i % PILE_ROTS.length];
    const el  = document.createElement('div');
    el.className       = 'card card-sm no-interact';
    el.style.transform = `rotate(${rot}deg)`;
    el.dataset.pileIdx = i;
    el.dataset.cardId  = card.id;

    if (card.revealed) {
      el.setAttribute('data-value', card.value === 'copy' ? 'copy' : card.value);
      el.innerHTML = effortCardHTML(card);
    } else {
      el.classList.add('card-back');
      el.setAttribute('aria-label', 'Face-down card');
      if (i === state.projectPile.length - 1) el.classList.add('card-mystery');
    }
    container.appendChild(el);
  });
}

// ─────────────────────────────────────────────────────────
//  PLAYERS BAR
// ─────────────────────────────────────────────────────────
export function renderPlayersBar(state) {
  const row = $('players-row');
  if (!row) return;
  row.innerHTML = '';

  for (const id of state.playerOrder) {
    const p        = state.players[id];
    const isActive = id === state.activePlayerId && !p.isExpelled;
    const isLeader = id === state.projectLeaderId && !p.isExpelled;
    const isSnitcher = id === state.snitchCurrentId;
    const isAccused  = id === state.blameAccusedId;

    const slot = document.createElement('div');
    slot.className        = 'player-slot';
    slot.id               = 'slot-' + id;
    slot.dataset.playerId = id;
    if (isActive)    slot.classList.add('active-turn');
    if (p.isExpelled) slot.classList.add('expelled');
    if (isAccused)   slot.classList.add('accused-ring');

    const roleText = p.isExpelled ? 'Expelled'
      : isLeader  ? 'Leader'
      : isSnitcher ? 'Snitching'
      : 'Player';

    const failTotal = totalFails(p);

    let inner =
      `<div class="slot-name">${esc(p.name)}</div>` +
      `<div class="slot-role">${roleText}</div>` +
      `<div class="slot-party">&#128128;&thinsp;${p.partyPile.length}</div>` +
      `<div class="fail-pips">${failPipsHTML(failTotal)}</div>`;

    if (p.extraCredits > 0) {
      inner += `<div class="slot-credits">${'&#9733;'.repeat(Math.min(p.extraCredits, 5))}</div>`;
    }

    if (p.isExpelled) inner += `<div class="expelled-stamp">OUT</div>`;

    // Show played-pair checkmark
    if (state.phase === 'PLAYING' && p.playedPair && !p.isExpelled) {
      inner += `<div class="slot-done">&#10003;</div>`;
    }

    slot.innerHTML = inner;
    row.appendChild(slot);
  }
}

// ─────────────────────────────────────────────────────────
//  HAND — pair grouping helper
// ─────────────────────────────────────────────────────────
function buildPairGroups(hand) {
  const used  = new Set();
  const pairs = [];

  // copy+copy first
  const copies = hand.filter(c => c.type === 'copy');
  if (copies.length >= 2) {
    pairs.push([copies[0], copies[1]]);
    used.add(copies[0].id);
    used.add(copies[1].id);
  }

  // effort pairs summing to 8
  const efforts = hand
    .filter(c => c.type === 'effort' && !used.has(c.id))
    .sort((a, b) => a.value - b.value);

  for (let i = 0; i < efforts.length; i++) {
    if (used.has(efforts[i].id)) continue;
    for (let j = i + 1; j < efforts.length; j++) {
      if (!used.has(efforts[j].id) && efforts[i].value + efforts[j].value === 8) {
        pairs.push([efforts[i], efforts[j]]);
        used.add(efforts[i].id);
        used.add(efforts[j].id);
        break;
      }
    }
  }

  // any unpaired cards (shouldn't happen in normal play)
  hand.filter(c => !used.has(c.id)).forEach(c => pairs.push([c]));

  return pairs;
}

// ─────────────────────────────────────────────────────────
//  HAND FAN  (cards displayed in legal pairs, no overlap)
// ─────────────────────────────────────────────────────────
export function renderHandFan(state, humanId) {
  const fan = $('hand-fan');
  if (!fan) return;

  const player = state.players[humanId];
  if (!player) { fan.innerHTML = ''; return; }

  const isMyTurn = state.phase === 'PLAYING'
    && state.activePlayerId === humanId
    && !player.playedPair;

  fan.dataset.isMyTurn     = isMyTurn ? '1' : '0';
  fan.dataset.selectedCard = '';
  fan.innerHTML = '';

  const strip = $('sel-strip');
  if (strip) strip.innerHTML = isMyTurn
    ? '<span class="sel-desc">Tap a card to send it to the <strong>Project</strong> — its partner goes to your Party Pile.</span>'
    : '<span class="sel-desc">Waiting for your turn...</span>';

  const pairGroups = buildPairGroups(player.hand);

  for (const pair of pairGroups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'pair-group';

    for (const card of pair) {
      const el = document.createElement('div');
      el.className      = 'card';
      el.dataset.value  = card.value;
      el.dataset.cardId = card.id;
      el.innerHTML      = effortCardHTML(card);

      if (!isMyTurn) {
        el.classList.add('no-interact');
      } else if (_cardClickCb && pair.length >= 2) {
        // One-click: clicked card goes to Project Pile, partner goes to Party
        const partnerCard = pair.find(c => c.id !== card.id);
        el.addEventListener('click', () => {
          if (fan.dataset.isMyTurn !== '1') return;
          _cardClickCb(partnerCard.id, card.id);  // (partyCardId, projectCardId)
        });
      } else {
        // Unpaired card (shouldn't happen) — not clickable
        el.classList.add('no-interact');
      }

      groupEl.appendChild(el);
    }

    fan.appendChild(groupEl);
  }

  const meta = document.querySelector('.hand-meta span:first-child');
  if (meta) {
    const n = player.hand.length;
    meta.textContent = `Your hand (${n} card${n !== 1 ? 's' : ''})`;
  }

  const section = document.querySelector('.hand-section');
  if (section) section.classList.toggle('hand-waiting', !isMyTurn);
}


export function renderLeadershipSkills(state) {
  const skillBar = $('skill-bar');
  if (!skillBar) return;

  // Always show during DEADLINE
  skillBar.style.display = state.phase === 'DEADLINE' ? 'flex' : 'none';
  if (state.phase !== 'DEADLINE') return;

  const upEl   = $('skill-faceup');
  const downEl = $('skill-facedown');

  if (upEl && state.faceUpSkill) {
    const s = state.faceUpSkill;
    upEl.innerHTML =
      `<div class="skill-name">${esc(s.name)}</div>` +
      `<div class="skill-desc">${esc(s.desc)}</div>`;
    upEl.style.display = '';
  } else if (upEl) {
    upEl.style.display = 'none';
  }

  if (downEl) {
    downEl.innerHTML =
      `<div class="skill-name">? Unknown Skill</div>` +
      `<div class="skill-desc">Tap to use this face-down Leadership Skill.</div>`;
    downEl.style.display = state.faceDownSkill ? '' : 'none';
  }
}

// ─────────────────────────────────────────────────────────
//  CONTROL BAR
// ─────────────────────────────────────────────────────────
export function renderControlBar(state, humanId) {
  const player     = humanId ? state.players[humanId] : null;
  const isExpelled = player?.isExpelled ?? true;

  const ALL_IDS = [
    'btn-project', 'btn-party', 'btn-continue',
    'btn-let-it-ride', 'btn-skill-faceup', 'btn-skill-facedown',
    'btn-blame',
    'btn-vote-accused', 'btn-vote-leader',
    'btn-snitch-target', 'btn-snitch-pass',
    'btn-scores',
  ];

  const btns = {};
  for (const id of ALL_IDS) {
    const el = document.getElementById(id);
    if (el) btns[id] = el;
  }

  // Hide everything
  for (const el of Object.values(btns)) {
    el.style.display = 'none';
    el.disabled = false;
  }

  if (isExpelled) return;

  const show = (id, disabled = false, text = null) => {
    const el = btns[id];
    if (!el) return;
    el.style.display = '';
    el.disabled = disabled;
    if (text !== null) el.textContent = text;
  };

  const isHumanTurn  = state.activePlayerId === humanId;
  const isLeader     = state.projectLeaderId === humanId;
  const isAccused    = state.blameAccusedId  === humanId;
  const isVoter      = state.blameVotersRemaining?.includes(humanId);
  const isSnitching  = state.snitchCurrentId === humanId;
  const isDrawer     = state.breakDrawCurrent === humanId;

  switch (state.phase) {

    case 'PLAYING': {
      // One-click card play handles human turns — no action-bar buttons needed.
      // AI turns auto-advance after queue drains — no continue button needed.
      break;
    }

    case 'REVEAL': {
      show('btn-continue', false, 'Reveal Cards →');
      break;
    }

    case 'DEADLINE': {
      if (isLeader && !state.pendingSkillStep) {
        show('btn-let-it-ride', false, 'Let It Ride');
        if (state.faceUpSkill) {
          show('btn-skill-faceup', false, `Use: ${state.faceUpSkill.name}`);
        }
        if (state.faceDownSkill) {
          show('btn-skill-facedown', false, 'Use: ? (Face-down Skill)');
        }
      } else if (state.pendingSkillStep === 'realign-pick-target' && isLeader) {
        // Overlay handles this
      } else {
        show('btn-continue', true, 'Leader is deciding…');
      }
      break;
    }

    case 'BLAME': {
      if (isLeader) {
        show('btn-blame', false, 'Accuse a Player');
      } else {
        show('btn-continue', true, 'Waiting for leader…');
      }
      break;
    }

    case 'BLAME_VOTE': {
      if (isVoter) {
        const accused = state.blameAccusedId ? state.players[state.blameAccusedId] : null;
        const leader  = state.projectLeaderId ? state.players[state.projectLeaderId] : null;
        show('btn-vote-accused', false,
          `Blame ${accused ? esc(accused.name) : 'Accused'}`);
        show('btn-vote-leader',  false,
          `Blame ${leader ? esc(leader.name) : 'Leader'}`);
      } else {
        show('btn-continue', true, 'Voting in progress…');
      }
      break;
    }

    case 'SNITCH': {
      if (isSnitching) {
        show('btn-snitch-target', false, 'Snitch on Someone');
        show('btn-snitch-pass',   false, 'Pass (End Chain)');
      } else {
        const snitcher = state.snitchCurrentId ? state.players[state.snitchCurrentId] : null;
        show('btn-continue', true,
          snitcher ? `Waiting for ${esc(snitcher.name)}…` : 'Waiting…');
      }
      break;
    }

    case 'BREAK': {
      const isLast = state.semester >= state.totalSemesters;
      show('btn-continue', false,
        isLast ? 'See Final Scores →' : 'Next Semester →');
      break;
    }

    case 'BREAK_DRAW': {
      if (isDrawer) {
        show('btn-continue', false, 'Draw New Pair');
      } else {
        const drawer = state.breakDrawCurrent ? state.players[state.breakDrawCurrent] : null;
        show('btn-continue', true,
          drawer ? `Waiting for ${esc(drawer.name)}…` : 'Waiting…');
      }
      break;
    }

    case 'GAMEOVER': {
      show('btn-scores', false, 'See Final Scores →');
      break;
    }
  }
}

export function getSelectedCardId() {
  const fan = $('hand-fan');
  return fan ? fan.dataset.selectedCard || null : null;
}

// ─────────────────────────────────────────────────────────
//  GAME LOG
// ─────────────────────────────────────────────────────────
export function renderLog(state) {
  const list = $('log-list');
  if (!list) return;

  const rendered   = parseInt(list.dataset.logCount ?? '0', 10);
  const newEntries = state.log.slice(rendered);
  if (newEntries.length === 0) return;

  // Prepend in forward order so newest entry ends up at top
  for (const entry of newEntries) {
    const li = document.createElement('li');
    li.className = `log-entry log-${entry.type}`;
    if (entry.playerId) li.dataset.playerId = entry.playerId;
    li.innerHTML =
      `<span class="log-sem">[S${entry.semester}]</span> ` + esc(entry.text);
    list.prepend(li);
  }

  list.dataset.logCount = state.log.length;
  // no scroll needed — new entries are already at the top
}

export function clearLog() {
  const list = $('log-list');
  if (!list) return;
  list.innerHTML = '';
  list.dataset.logCount = '0';
}

// ─────────────────────────────────────────────────────────
//  SCOREBOARD
// ─────────────────────────────────────────────────────────
export function renderScoreboard(state) {
  const body = document.querySelector('.score-body');
  if (!body) return;

  const sorted = state.playerOrder
    .map(id => ({ id, ...state.players[id] }))
    .sort((a, b) => {
      if (a.isExpelled !== b.isExpelled) return a.isExpelled ? 1 : -1;
      return b.academicPoints - a.academicPoints;
    });

  let activeRank = 0;
  const rows = sorted.map(p => {
    let rankDisplay, rowClass, ptsDisplay, ptsLabel, tagText;

    if (p.isExpelled) {
      rankDisplay = '&mdash;';
      rowClass    = 'score-row expelled-row';
      ptsDisplay  = '&mdash;';
      ptsLabel    = 'Expelled';
      tagText     = `Expelled &mdash; ${totalFails(p)} total fails`;
    } else {
      activeRank++;
      rankDisplay = activeRank;
      rowClass    = activeRank === 1 ? 'score-row winner' : 'score-row';
      ptsDisplay  = p.academicPoints;
      ptsLabel    = 'Points';
      tagText     = _scoreTagText(p, activeRank);
    }

    return (
      `<div class="${rowClass}">` +
        `<div class="s-rank">${rankDisplay}</div>` +
        `<div class="s-av">${esc(initials(p.name))}</div>` +
        `<div class="s-info">` +
          `<div class="s-name">${esc(p.name)}</div>` +
          `<div class="s-tag">${tagText}</div>` +
        `</div>` +
        `<div class="s-pts">` +
          `<div class="s-pts-val">${ptsDisplay}</div>` +
          `<div class="s-pts-lbl">${ptsLabel}</div>` +
        `</div>` +
      `</div>`
    );
  });

  const passCount = state.log.filter(e => e.type === 'pass').length;
  const failCount = state.log.filter(e => e.type === 'fail' && e.text.startsWith('Project FAILED')).length;
  const verdict   = passCount >= failCount ? 'PASS' : 'FAIL';

  body.innerHTML =
    rows.join('') +
    `<div class="result-card">` +
      `<div class="sec-lbl">Group Project Result</div>` +
      `<div class="result-verdict ${verdict.toLowerCase()}">${verdict}</div>` +
      `<div class="result-detail">${passCount} semester${passCount !== 1 ? 's' : ''} passed, ${failCount} failed.</div>` +
    `</div>`;

  const badge = document.querySelector('#s-score .hdr-badge');
  if (badge) badge.textContent = `${state.semester} / ${state.totalSemesters} Semesters`;

  // Score tally animation
  const ptEls = body.querySelectorAll('.score-row:not(.expelled-row) .s-pts-val');
  ptEls.forEach((el, i) => {
    const finalVal = parseInt(el.textContent, 10);
    if (isNaN(finalVal) || finalVal <= 0) return;
    el.textContent = '0';
    setTimeout(() => _animScoreCounter(el, 0, finalVal, 680), 280 + i * 260);
  });
}

function _animScoreCounter(el, from, to, duration) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - (1 - t) * (1 - t);
    el.textContent = Math.round(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
    else { el.textContent = to; el.classList.add('anim-shimmer'); }
  }
  requestAnimationFrame(tick);
}

function _scoreTagText(p, rank) {
  if (rank === 1) return 'Biggest slacker &mdash; graduated with honours! &#127891;';
  if (p.extraCredits > 0) {
    const clean = p.individualFails === 0 ? ' (clean bonus!)' : '';
    return `${p.extraCredits} Extra Credit${p.extraCredits > 1 ? 's' : ''}${clean}`;
  }
  if (totalFails(p) >= 3) return 'Barely scraped through';
  return 'Held the group together';
}

// ─────────────────────────────────────────────────────────
//  FULL RENDER
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
//  PLAYER STATUS PANEL  (human's own party pile + score)
// ─────────────────────────────────────────────────────────
export function renderPlayerStatus(state, humanId) {
  const el = document.getElementById('player-status-row');
  if (!el) return;
  const p = humanId ? state.players[humanId] : null;
  if (!p) { el.style.display = 'none'; return; }
  el.style.display = '';

  let cards = '';
  if (p.partyPile && p.partyPile.length > 0) {
    cards = p.partyPile.map(c => {
      const val = c.type === 'copy' ? 'X2' : (c.value !== undefined ? c.value : '?');
      return `<div class="party-mini-card" data-value="${val}">${val}</div>`;
    }).join('');
  } else {
    cards = '<span class="party-empty">Empty</span>';
  }

  el.innerHTML =
    '<div class="status-section">' +
      '<div class="status-lbl">Your Hidden Cards (' + (p.partyPile ? p.partyPile.length : 0) + ')</div>' +
      '<div class="party-cards-row">' + cards + '</div>' +
    '</div>' +
    '<div class="status-score">' +
      '<div class="status-lbl">Your Score</div>' +
      '<div class="status-pts">' + (p.academicPoints || 0) + '</div>' +
    '</div>';
}

export function renderAll(state, humanId) {
  renderGameHeader(state);
  renderProjectPile(state);
  renderPlayersBar(state);
  renderHandFan(state, humanId);
  renderLeadershipSkills(state);
  renderControlBar(state, humanId);
  renderLog(state);
  renderPlayerStatus(state, humanId);
}
