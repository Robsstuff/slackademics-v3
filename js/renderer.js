/* =====================================================
   SLACKADEMICS — Renderer (Rulebook v2)
   Idempotent DOM writers using actual card artwork.
   ===================================================== */
'use strict';

import { EFFORT_IMGS, COURSE_NAMES, SEMESTER_NAMES, totalFails } from './state.js';
import { computePileTotal, activePlayers } from './engine.js';

// ── Card image base paths ─────────────────────────────────
const EFFORT_BASE     = './cards/effort/';
const LEADERSHIP_BASE = '../CARDS/Leadership Cards/';
const OTHER_BASE      = './cards/other/';
const CARD_BACK_SRC   = './cards/Card Back Regular.jpg';
const FAIL_PIP_SRC    = './cards/fail-pip.jpg';
const EXTRA_CRED_SRC  = './cards/extra-credit.jpg';

// ── Module-level state ────────────────────────────────────
let _projectTarget = 20;   // updated from state on every renderGameHeader
let _cardClickCb      = null; // set by main.js for one-click card play
let _currentSkillBonus = 0;  // set when skill resolves; cleared each semester
export function setSkillBonus(n) { _currentSkillBonus = n; }

/** Set the callback invoked when human clicks a card in their hand.
 *  Signature: onCardClick(partyCardId, projectCardId) */
export function setCardClickCallback(fn) { _cardClickCb = fn; }

// ── Slacker Bank — permanent, locked total shown next to the party
// pile. Once a round's Slacker cards are banked here they can never
// be moved or changed again by any later round's events.
function _slackerBankCount(state, playerId) {
  return state.slackerTokens?.[playerId] ?? 0;
}

// ── Current-round Slacker pile — cards not yet banked. Still fully
// mutable (votes, tie-break, appeal can move these) until the round
// ends, at which point they're capped and merged into the bank.
function _currentRoundSlackerCount(state, playerId) {
  if (state.phase === 'GROUP_EVAL') {
    let live = 0;
    for (const targetId of Object.values(state.roundSlackerVotes || {})) {
      if (targetId === playerId) live++;
    }
    return live;
  }
  if (state.phase === 'GROUP_EVAL_LEADER_TIE') {
    return state.evalRoundCounts?.[playerId] ?? 0;
  }
  return 0;
}

// ── Phase display ─────────────────────────────────────────
const PHASE_LABEL = {
  PLAYING:               'Playing Cards',
  REVEAL:                'Reveal',
  DEADLINE:              'Day of Deadline',
  BLAME:                 'Blame Phase',
  BLAME_VOTE:            'Voting',
  SNITCH:                'Snitch Phase',
  BREAK:                 'Semester Break',
  BREAK_DRAW:            'Draw New Pair',
  GROUP_EVAL:            'Group Evaluation',
  GROUP_EVAL_LEADER_TIE: 'Tie Break',
  SIMPLE_BLAME_VOTE:     "Who's to Blame?",
  SIMPLE_BLAME_LEADER_TIE: 'Tie Break',
  SIMPLE_FAIL_SNITCH:    'Snitch Chain',
  SIMPLE_SELF_REVEAL:    'Self-Reveal',
  GAMEOVER:              'Game Over',
};

const PHASE_SUB = {
  PLAYING:               'Playing',
  REVEAL:                'Revealing',
  DEADLINE:              'Deadline',
  BLAME:                 'Blaming',
  BLAME_VOTE:            'Voting',
  SNITCH:                'Snitching',
  BREAK:                 'Break',
  BREAK_DRAW:            'Drawing',
  GROUP_EVAL:            'Evaluating',
  GROUP_EVAL_LEADER_TIE: 'Tie Break',
  SIMPLE_BLAME_VOTE:     'Voting',
  SIMPLE_BLAME_LEADER_TIE: 'Tie Break',
  SIMPLE_FAIL_SNITCH:    'Snitching',
  SIMPLE_SELF_REVEAL:    'Revealing',
  GAMEOVER:              'Game Over',
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
    if (i < count) {
      html += `<div class="fail-pip filled"><img src="${FAIL_PIP_SRC}" alt="Fail" class="fail-pip-img"/></div>`;
    } else {
      html += `<div class="fail-pip empty"></div>`;
    }
  }
  return html;
}

const $ = id => document.getElementById(id);

// ── Compute cram/cheat effect counts for project pile display ──
// Both count only within the project pile (bonus/penalty is per-project).
function _computeEffects(state) {
  return {
    cramCount:  state.projectPile.filter(c => c.type === 'cram').length,
    cheatCount: state.projectPile.filter(c => c.type === 'cheat').length,
  };
}

// ── Resolve image key for any card type ──────────────────
function _cardImgKey(card) {
  if (card.type === 'cram')   return `cram${card.value}`;  // 'cram6' or 'cram2'
  if (card.type === 'cheat')  return 'cheat';
  if (card.type === 'colead') return 'colead';
  if (card.type === 'copy')   return 'copy';
  return card.value;   // regular effort cards: numeric key
}

// ── Build effort card HTML — clean card photo, no overlay ──
function effortCardHTML(card) {
  const name    = esc(card.name ?? (card.type === 'copy' ? 'X2 Copy' : `Effort ${card.value}`));
  const imgKey  = _cardImgKey(card);
  const imgFile = EFFORT_IMGS[imgKey] ?? EFFORT_IMGS[card.value] ?? '4.jpg';
  const imgSrc  = EFFORT_BASE + imgFile;
  return `<img src="${imgSrc}" alt="${name}" `
       + `style="width:100%;height:100%;object-fit:cover;display:block;" />`;
}

export function buildEffortCardHTML(card) { return effortCardHTML(card); }

// ─────────────────────────────────────────────────────────
//  GAME HEADER
// ── Effort bar helper (drives the prominent bar row in header) ──
function _updateEffortBar(total, hidden) {
  const fill      = $('effort-bar-fill');
  const skillFill = $('effort-bar-skill');
  const cur       = $('effort-bar-current');
  const tgt       = $('effort-bar-target');
  if (tgt) tgt.textContent = _projectTarget;
  if (hidden) {
    if (fill)      { fill.style.width = '0%'; fill.classList.remove('over-target'); }
    if (skillFill) skillFill.style.width = '0%';
    if (cur)       cur.textContent = '?';
    return;
  }
  if (cur) cur.textContent = total;
  if (fill) {
    const bonus    = _currentSkillBonus;
    const base     = total - bonus;
    const basePct  = _projectTarget > 0 ? Math.min(base  / _projectTarget * 100, 100) : 0;
    const bonusPct = _projectTarget > 0 && bonus > 0
      ? Math.min(bonus / _projectTarget * 100, 100 - basePct)
      : 0;
    fill.style.width = basePct + '%';
    fill.classList.toggle('over-target', total > _projectTarget);
    if (skillFill) skillFill.style.width = bonusPct + '%';
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
  if (pipVal) {
    if (isPlaying) {
      pipVal.textContent = '?';
    } else {
      const revPile = state.projectPile.filter(c => c.revealed);
      pipVal.textContent = String(computePileTotal(revPile, _computeEffects(state)));
    }
  }

  // Prominent effort bar — use computePileTotal so Cram/Cheat bonuses show correctly
  if (isPlaying) {
    _updateEffortBar(0, true);
  } else {
    const revealedPile = state.projectPile.filter(c => c.revealed);
    const effects      = _computeEffects(state);
    const total        = computePileTotal(revealedPile, effects);
    _updateEffortBar(total, false);
  }

  const tgt = document.querySelector('.pile-target strong');
  if (tgt) tgt.textContent = state.projectTarget;

  const pool = document.querySelector('.pool-badge strong');
  if (pool) pool.textContent = state.effortPool.length;

  // Prominent exam name banner
  const semIdx   = Math.max(0, Math.min(state.semester - 1, 7));
  const fullName = COURSE_NAMES[semIdx] ?? '';
  const examCode  = $('exam-code');
  const examTitle = $('exam-title');
  if (examCode)  examCode.textContent  = state.semesterName ?? '';
  if (examTitle) examTitle.textContent = fullName;

  // Legacy hidden semester-name (kept for any other compat code)
  const semName = document.querySelector('.semester-name');
  if (semName) {
    semName.innerHTML =
      '<span class="course-code">' + esc(state.semesterName ?? '') + '</span>' +
      ' <span class="course-title">' + esc(fullName) + '</span>';
  }
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

    const failTotal    = totalFails(p);
    const failLimit    = state.failLimit ?? 5;
    const slackerBank  = _slackerBankCount(state, id);
    const slackerRound = _currentRoundSlackerCount(state, id);

    let inner =
      `<div class="slot-name">${esc(p.name)}</div>` +
      `<div class="slot-role">${roleText}</div>` +
      `<div class="slot-party">` +
        `<img src="${CARD_BACK_SRC}" alt="cards" class="party-pile-back"/><span class="party-pile-count">${p.partyPile.length}</span>` +
        (slackerBank > 0
          ? `<span class="slacker-bank-badge" title="Slacker Bank — locked, ${slackerBank * 3} point${slackerBank * 3 !== 1 ? 's' : ''} off final score">` +
              `<img src="./cards/slacker.jpg" alt="Slacker Bank" class="slacker-bank-icon"/>` +
              `<span class="slacker-bank-count">${slackerBank}</span>` +
            `</span>`
          : '') +
      `</div>` +
      `<div class="fail-pips">${failPipsHTML(failTotal, failLimit)}</div>` +
      (slackerRound > 0
        ? `<div class="slot-slacker-tokens" title="Slacker cards this round — not yet banked">` +
            `<img src="./cards/slacker.jpg" alt="Slacker (this round)" class="slacker-token-icon"/>` +
            `<span class="slacker-token-count">${slackerRound}</span>` +
          `</div>`
        : '');

    const ssoCount = state.successfulSlackOff?.[id] ?? 0;
    if (ssoCount > 0) {
      inner += `<div class="slot-sso" title="Successful Slack Off — +${ssoCount * 5} pts">` +
        `<img src="./cards/successful-slack-off.jpg" alt="SSO" class="sso-icon"/>` +
        `<span class="sso-count">×${ssoCount}</span>` +
      `</div>`;
    }

    if (p.extraCredits > 0) {
      const ecCount = Math.min(p.extraCredits, 5);
      let ecHtml = '';
      for (let i = 0; i < ecCount; i++) {
        ecHtml += `<img src="${EXTRA_CRED_SRC}" alt="Extra Credit" class="ec-pip-img"/>`;
      }
      inner += `<div class="slot-credits">${ecHtml}</div>`;
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

  // cram pairs (6+2 = 8)
  const crams = hand.filter(c => c.type === 'cram' && !used.has(c.id));
  for (let i = 0; i < crams.length; i++) {
    if (used.has(crams[i].id)) continue;
    for (let j = i + 1; j < crams.length; j++) {
      if (!used.has(crams[j].id) && crams[i].value + crams[j].value === 8) {
        pairs.push([crams[i], crams[j]]);
        used.add(crams[i].id);
        used.add(crams[j].id);
        break;
      }
    }
  }

  // cheat pairs (5+5)
  const cheats = hand.filter(c => c.type === 'cheat' && !used.has(c.id));
  if (cheats.length >= 2) {
    pairs.push([cheats[0], cheats[1]]);
    used.add(cheats[0].id);
    used.add(cheats[1].id);
  }

  // colead pairs (4+4)
  const coleads = hand.filter(c => c.type === 'colead' && !used.has(c.id));
  if (coleads.length >= 2) {
    pairs.push([coleads[0], coleads[1]]);
    used.add(coleads[0].id);
    used.add(coleads[1].id);
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
      // Voting is handled entirely by the card-artwork overlay (_openBlameVoteOverlay).
      // Show a disabled status label for everyone while the vote is in progress.
      show('btn-continue', true, 'Voting in progress…');
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

    case 'GROUP_EVAL': {
      const waiting = state.evalVotersRemaining ?? [];
      if (waiting.includes(humanId)) {
        show('btn-continue', true, 'Select who slacked off…');
      } else if (waiting.length > 0) {
        show('btn-continue', true, 'Waiting for other votes…');
      } else {
        show('btn-continue', true, 'Counting votes…');
      }
      break;
    }

    case 'GROUP_EVAL_LEADER_TIE': {
      if (isLeader) {
        show('btn-continue', true, 'Choose who to accuse (tie break)…');
      } else {
        show('btn-continue', true, `Waiting for ${esc(state.players[state.projectLeaderId]?.name ?? 'leader')}…`);
      }
      break;
    }

    case 'SIMPLE_BLAME_VOTE': {
      const waiting = state.failVoteVotersRemaining ?? [];
      if (waiting.includes(humanId)) {
        show('btn-continue', true, "Select who's to blame…");
      } else if (waiting.length > 0) {
        show('btn-continue', true, 'Waiting for other votes…');
      } else {
        show('btn-continue', true, 'Counting votes…');
      }
      break;
    }

    case 'SIMPLE_BLAME_LEADER_TIE': {
      if (isLeader) {
        show('btn-continue', true, 'Choose who to blame (tie break)…');
      } else {
        show('btn-continue', true, `Waiting for ${esc(state.players[state.projectLeaderId]?.name ?? 'leader')}…`);
      }
      break;
    }

    case 'SIMPLE_FAIL_SNITCH': {
      const isHolder = state.simpleSnitchCurrentId === humanId;
      if (isHolder) {
        show('btn-continue', true, 'Snitch on someone or pass…');
      } else {
        const holder = state.simpleSnitchCurrentId ? state.players[state.simpleSnitchCurrentId] : null;
        show('btn-continue', true,
          holder ? `Waiting for ${esc(holder.name)}…` : 'Waiting…');
      }
      break;
    }

    case 'SIMPLE_SELF_REVEAL': {
      const revealing = state.simpleSelfRevealPlayerId === humanId;
      if (revealing) {
        show('btn-continue', true, 'Reveal yourself or stay hidden…');
      } else {
        const revealer = state.simpleSelfRevealPlayerId ? state.players[state.simpleSelfRevealPlayerId] : null;
        show('btn-continue', true,
          revealer ? `Waiting for ${esc(revealer.name)}…` : 'Waiting…');
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

  const isAllExpelled     = state.gameEndReason === 'all-expelled';
  const specialWinnersSet = new Set(state.specialWinners || []);

  const sorted = state.playerOrder
    .map(id => ({ id, ...state.players[id] }))
    .sort((a, b) => {
      if (isAllExpelled) {
        // Special winners float to the top; then by fewer fails
        const aW = specialWinnersSet.has(a.id) ? 0 : 1;
        const bW = specialWinnersSet.has(b.id) ? 0 : 1;
        if (aW !== bW) return aW - bW;
        return totalFails(a) - totalFails(b);
      }
      if (a.isExpelled !== b.isExpelled) return a.isExpelled ? 1 : -1;
      return b.academicPoints - a.academicPoints;
    });

  let activeRank = 0;
  const rows = sorted.map(p => {
    let rankDisplay, rowClass, ptsDisplay, ptsLabel, tagText;

    const isSpecialWinner = isAllExpelled && specialWinnersSet.has(p.id);

    if (isSpecialWinner) {
      // All-expelled special winner: highlighted, star rank
      rankDisplay = '&#9733;';
      rowClass    = 'score-row winner special-winner';
      ptsDisplay  = '&#8212;';
      ptsLabel    = 'Special Win';
      const fc    = state.players[p.id].semesterProjectCard;
      const fv    = fc ? (fc.type === 'copy' ? 'Copy (0)' : fc.value) : '?';
      tagText     = `Highest project card &mdash; ${fv} effort`;
    } else if (p.isExpelled) {
      rankDisplay = '&mdash;';
      rowClass    = 'score-row expelled-row';
      ptsDisplay  = '0';          // show 0 (not dash) per game rules
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

    // Party pile card thumbnails (simple mode only, active players)
    let pileHtml = '';
    if (state.gameMode === 'simple' && !p.isExpelled && !isSpecialWinner) {
      const pile = (state.players[p.id]?.partyPile ?? []);
      if (pile.length > 0) {
        const thumbs = pile.map(c => {
          const val = c.type === 'copy' ? 'X2' : (c.value !== undefined ? c.value : '?');
          return `<div class="score-pile-card" data-value="${val}">${val}</div>`;
        }).join('');
        pileHtml = `<div class="score-pile-row">${thumbs}</div>`;
      }
      const ssoN = state.successfulSlackOff?.[p.id] ?? 0;
      if (ssoN > 0) {
        pileHtml += `<div class="score-sso-row">` +
          `<img src="./cards/successful-slack-off.jpg" class="score-sso-img" alt="SSO"/>` +
          `<span>×${ssoN}</span></div>`;
      }
    }

    return (
      `<div class="${rowClass}">` +
        `<div class="s-rank">${rankDisplay}</div>` +
        `<div class="s-av">${esc(initials(p.name))}</div>` +
        `<div class="s-info">` +
          `<div class="s-name">${esc(p.name)}</div>` +
          `<div class="s-tag">${tagText}</div>` +
          pileHtml +
        `</div>` +
        `<div class="s-pts">` +
          `<div class="s-pts-val">${ptsDisplay}</div>` +
          `<div class="s-pts-lbl">${ptsLabel}</div>` +
        `</div>` +
      `</div>`
    );
  });

  // Result card — different copy for all-expelled vs normal
  let resultSection;
  if (isAllExpelled) {
    const winnerNames = (state.specialWinners || [])
      .map(id => esc(state.players[id]?.name ?? '?')).join(' &amp; ') || '—';
    resultSection =
      `<div class="result-card">` +
        `<div class="sec-lbl">Game Outcome</div>` +
        `<div class="result-verdict fail">ALL EXPELLED</div>` +
        `<div class="result-detail">Special Win: ${winnerNames} — highest project card in the final round.</div>` +
      `</div>`;
  } else {
    const passCount = state.log.filter(e => e.type === 'pass').length;
    const failCount = state.log.filter(e => e.type === 'fail' && e.text.startsWith('Project FAILED')).length;
    const verdict   = passCount >= failCount ? 'PASS' : 'FAIL';
    resultSection =
      `<div class="result-card">` +
        `<div class="sec-lbl">Group Project Result</div>` +
        `<div class="result-verdict ${verdict.toLowerCase()}">${verdict}</div>` +
        `<div class="result-detail">${passCount} semester${passCount !== 1 ? 's' : ''} passed, ${failCount} failed.</div>` +
      `</div>`;
  }

  body.innerHTML = rows.join('') + resultSection;

  const badge = document.querySelector('#s-score .hdr-badge');
  if (badge) badge.textContent = `${state.semester} / ${state.totalSemesters} Semesters`;

  // Score tally animation — skip special-winner rows (no numeric score)
  const ptEls = body.querySelectorAll(
    '.score-row:not(.expelled-row):not(.special-winner) .s-pts-val'
  );
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
    return `${p.extraCredits} Extra Credit${p.extraCredits > 1 ? 's' : ''}`;
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

  // Live score: party pile total + extra credit bonuses (mirrors _computeFinalScores)
  // Both Cram and Cheat: count only within THIS player's own party pile
  const _cramC  = (p.partyPile || []).filter(c => c.type === 'cram').length;
  const _cheatC = (p.partyPile || []).filter(c => c.type === 'cheat').length;
  const partyScore = computePileTotal(p.partyPile || [], { cramCount: _cramC, cheatCount: _cheatC });
  const ecBonus    = (p.extraCredits || 0) * 3;
  const cleanBonus = (state.gameMode !== 'simple' && (p.individualFails || 0) === 0) ? (p.extraCredits || 0) * 2 : 0;
  const slackerPenalty = state.gameMode === 'simple'
    ? (state.slackerTokens?.[humanId] ?? 0) * 3
    : 0;
  const slackOffBonus = state.gameMode === 'simple'
    ? (state.successfulSlackOff?.[humanId] ?? 0) * 5
    : 0;
  const liveScore  = state.phase === 'GAMEOVER'
    ? (p.academicPoints || 0)
    : Math.max(0, partyScore) + ecBonus + cleanBonus - slackerPenalty + slackOffBonus;

  const ssoCount = state.gameMode === 'simple' ? (state.successfulSlackOff?.[humanId] ?? 0) : 0;
  const ssoHtml  = ssoCount > 0
    ? '<div class="sso-pile-row">' +
        `<img src="./cards/successful-slack-off.jpg" alt="Successful Slack Off" class="sso-pile-img"/>` +
        `<span class="sso-pile-label">×${ssoCount} Successful Slack Off</span>` +
      '</div>'
    : '';

  el.innerHTML =
    '<div class="status-section">' +
      '<div class="status-lbl">Your Party Pile (' + (p.partyPile ? p.partyPile.length : 0) + ')</div>' +
      '<div class="party-cards-row">' + cards + '</div>' +
      ssoHtml +
    '</div>' +
    '<div class="status-score">' +
      '<div class="status-lbl">Your Score</div>' +
      '<div class="status-pts">' + liveScore + '</div>' +
    '</div>';
}

// ─────────────────────────────────────────────────────────
//  SNITCH INFO PANEL
// ─────────────────────────────────────────────────────────
export function renderSnitchPanel(state, humanId) {
  const panel = document.getElementById('snitch-info-panel');
  if (!panel) return;

  // Only show during SNITCH phase when it's the human's turn to snitch
  if (state.phase !== 'SNITCH' || state.snitchCurrentId !== humanId) {
    panel.style.display = 'none';
    return;
  }

  const p      = humanId ? state.players[humanId] : null;
  if (!p) { panel.style.display = 'none'; return; }

  panel.style.display = '';

  // Human's own party card value
  // Only copy cards count as 9; cram/cheat/colead use their base value
  const myCard = p.partyPile[p.partyPile.length - 1];
  const myVal  = myCard ? (myCard.type === 'copy' ? 9 : myCard.value) : 0;
  const myDisp = myCard ? (myCard.type === 'copy' ? 'X2' : myCard.value) : '?';

  // Infer other active players' party cards from their project pile cards
  const alreadySnitched = state.snitchedThisTurn || [];
  const others          = activePlayers(state).filter(id => id !== humanId);

  let countGe  = 0;   // eligible targets whose inferred value >= myVal
  const otherCards = [];
  for (const id of others) {
    const projCard  = state.projectPile.find(c => c.playerId === id);
    let inferredVal = 4;    // fallback for unrevealed cards
    let displayVal  = '?';
    if (projCard && projCard.revealed) {
      if (projCard.type === 'copy') {
        // copy project → copy party (snitch value 9)
        inferredVal = 9;
        displayVal  = 'X2';
      } else if (projCard.type === 'effort') {
        // effort: partner sums to 8
        inferredVal = Math.max(0, 8 - projCard.value);
        displayVal  = inferredVal;
      } else if (projCard.type === 'cram') {
        // cram6 → partner is cram2; cram2 → partner is cram6
        inferredVal = projCard.value === 6 ? 2 : 6;
        displayVal  = inferredVal;
      } else {
        // cheat(5+5) or colead(4+4): same value both cards
        inferredVal = projCard.value;
        displayVal  = inferredVal;
      }
    }
    const eligible = !alreadySnitched.includes(id);
    // Percentage is over ELIGIBLE targets only (can't snitch already-snitched players)
    if (eligible && inferredVal >= myVal) countGe++;
    otherCards.push({ displayVal, inferredVal, eligible });
  }

  // Sort descending for display
  otherCards.sort((a, b) => b.inferredVal - a.inferredVal);

  const eligibleCount = others.filter(id => !alreadySnitched.includes(id)).length;
  const pct = eligibleCount > 0 ? Math.round((countGe / eligibleCount) * 100) : 0;

  let cardsHtml = `<div class="snitch-card-chip mine" title="Your party card">${esc(String(myDisp))}</div>`;
  for (const c of otherCards) {
    const cls = c.eligible ? 'snitch-card-chip other' : 'snitch-card-chip other ineligible';
    cardsHtml += `<div class="${cls}">${esc(String(c.displayVal))}</div>`;
  }

  panel.innerHTML =
    '<div class="snitch-panel-hdr">Snitch Window</div>' +
    '<div class="snitch-panel-cards">' + cardsHtml + '</div>' +
    '<div class="snitch-panel-pct">' +
      '<span class="snitch-pct-val">' + pct + '%</span>' +
      '<span class="snitch-pct-lbl"> correct snitch chance</span>' +
    '</div>' +
    '<div class="snitch-panel-note">' +
      (eligibleCount > 0
        ? eligibleCount + ' player' + (eligibleCount !== 1 ? 's' : '') + ' can be snitched'
        : 'No eligible targets — you must pass') +
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
