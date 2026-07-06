/* =====================================================
   SLACKADEMICS — Animation Queue (Rulebook v2)
   Sequential DOM animation system.

   Architecture:
     GameEvent[]
       → buildStepsFromEvents(events, state)
       → Step[]
       → enqueueAll(steps)
       → run()
       → DOM

   Each Step:
     { label, callback, payload, duration, overlap }
   ===================================================== */
'use strict';

import { sleep }                          from './utils.js';
import {
  renderGameHeader,
  renderProjectPile,
  renderPlayersBar,
  renderHandFan,
  renderLeadershipSkills,
  renderControlBar,
  renderLog,
  renderEffortCounter,
  buildEffortCardHTML,
  renderPlayerStatus,
  renderSnitchPanel,
  setSkillBonus,
}                                          from './renderer.js';

// ── Deterministic pile rotations (matches renderer.js) ──
const PILE_ROTS = [-4, 3, -2, 5, -1, 2, -3, 4, -5, 1, -6, 3, 2, -4];

// ─────────────────────────────────────────────────────
//  QUEUE STATE
// ─────────────────────────────────────────────────────
const _queue    = [];
let _isRunning  = false;
let _humanId    = null;
let _onDone     = null;

// ─────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────

export function setHumanId(id)  { _humanId = id; }
export function setOnDone(cb)   { _onDone = cb; }
export const   isRunning = ()   => _isRunning;
export function enqueue(step)   { _queue.push(step); }
export function enqueueAll(steps) {
  for (const s of steps) _queue.push(s);
}
export function clearQueue()    { _queue.length = 0; }

export async function run() {
  if (_isRunning) return;
  _isRunning = true;
  _lockUI(true);

  const fastMode = window._slk_anim === false;

  while (_queue.length > 0) {
    const step = _queue.shift();
    try {
      await Promise.resolve(step.callback(step.payload ?? {}));
    } catch (err) {
      console.error(`[AnimQueue] step "${step.label}" threw:`, err);
    }
    // In fast mode skip all waits so the game advances instantly
    const wait = fastMode ? 0 : Math.max(0, (step.duration ?? 0) - (step.overlap ?? 0));
    if (wait > 0) await sleep(wait);
  }

  _isRunning = false;
  _lockUI(false);
  if (_onDone) _onDone();
}

// ─────────────────────────────────────────────────────
//  UI LOCK
// ─────────────────────────────────────────────────────
function _lockUI(locked) {
  const bar = document.querySelector('.action-bar');
  if (!bar) return;
  bar.querySelectorAll('button').forEach(btn => {
    if (locked) {
      btn.dataset.wasDisabled = btn.disabled ? '1' : '0';
      btn.disabled = true;
    } else {
      if (btn.dataset.wasDisabled !== '1') btn.disabled = false;
    }
  });
}

// ─────────────────────────────────────────────────────
//  BUILD STEPS FROM EVENTS
// ─────────────────────────────────────────────────────

export function buildStepsFromEvents(events, state) {
  const steps = [];

  for (const ev of events) {
    switch (ev.type) {

      // ── Card play ──────────────────────────────────
      case 'CARD_PLAYED_PROJECT':
      case 'CARD_PLAYED_PARTY':
        steps.push(..._stepsCardPlayed(ev, state));
        break;

      case 'TURN_ADVANCED':
        steps.push(_stepTurnAdvanced(ev, state));
        break;

      // ── Reveal ────────────────────────────────────
      case 'REVEAL_START':
        steps.push(_stepRevealStart(ev, state));
        break;

      case 'CARD_REVEALED':
        steps.push(..._stepsCardRevealed(ev, state));
        break;

      case 'EFFORT_UPDATED':
        steps.push(_stepEffortUpdated(ev, state));
        break;

      // ── Deadline ──────────────────────────────────
      case 'DEADLINE_START':
        steps.push(_stepDeadlineStart(ev, state));
        break;

      case 'SKILL_USED':
        steps.push(_stepSkillUsed(ev, state));
        break;

      case 'REALIGN_SWAP':
      case 'CARDS_REMOVED':
      case 'SKILL_NEEDS_TARGET':
        steps.push(_stepReRender(ev, state));
        break;

      // ── Outcome ───────────────────────────────────
      case 'PROJECT_PASSED':
        steps.push(_stepProjectPassed(ev, state));
        break;

      case 'PROJECT_FAILED':
        steps.push(_stepProjectFailed(ev, state));
        break;

      // ── Fail / expulsion ──────────────────────────
      case 'GROUP_FAIL':
        steps.push(_stepGroupFail(ev, state));
        break;

      case 'INDIVIDUAL_FAIL':
        steps.push(_stepIndividualFail(ev, state));
        break;

      case 'EXTRA_CREDIT':
        steps.push(_stepExtraCredit(ev, state));
        break;

      case 'PLAYER_EXPELLED':
        steps.push(_stepPlayerExpelled(ev, state));
        break;

      // ── Blame ─────────────────────────────────────
      case 'BLAME_CAST':
        steps.push(_stepBlameCast(ev, state));
        break;

      case 'BLAME_SKIPPED':
        steps.push(_stepBlameSkipped(ev, state));
        break;

      case 'VOTING_START':
        steps.push(_stepVotingStart(ev, state));
        break;

      case 'VOTE_CAST':
      case 'NEXT_VOTER':
        steps.push(_stepReRender(ev, state));
        break;

      case 'VOTES_TALLIED':
        steps.push(..._stepsVotesTallied(ev, state));
        break;

      case 'TIE_INVESTIGATION':
        steps.push(_stepTieInvestigation(ev, state));
        break;

      // ── Snitch ────────────────────────────────────
      case 'SNITCH_PHASE_START':
        steps.push(_stepSnitchPhaseStart(ev, state));
        break;

      case 'SNITCH_REVEALED':
        steps.push(_stepSnitchRevealed(ev, state));
        break;

      case 'SNITCH_SUCCESS':
        steps.push(_stepSnitchResult(ev, state, true));
        break;

      case 'SNITCH_FAIL':
        steps.push(_stepSnitchResult(ev, state, false));
        break;

      case 'SNITCH_PASSED':
        steps.push(_stepSnitchPassed(ev, state));
        break;

      case 'SNITCH_TURN':
      case 'SNITCH_DISCARD':
      case 'PARTY_CARDS_DISCARDED':
        steps.push(_stepReRender(ev, state));
        break;

      // ── Semester break ────────────────────────────
      case 'SEMESTER_BREAK_START':
        steps.push(_stepSemesterBreakStart(ev, state));
        break;

      case 'PAIR_DRAWN':
        steps.push(_stepPairDrawn(ev, state));
        break;

      case 'BREAK_DRAW_NEXT':
        steps.push(_stepReRender(ev, state));
        break;

      case 'SEMESTER_START':
        steps.push(_stepSemesterStart(ev, state));
        break;

      // ── Group Evaluation (Simple mode) ────────────
      case 'GROUP_EVAL_SKIPPED':
        steps.push({
          label: 'GROUP_EVAL_SKIPPED',
          duration: 900,
          payload: { state },
          callback({ state }) {
            renderControlBar(state, _humanId);
            renderLog(state);
            _showBanner('pass', 'Extra credit awarded — Group Evaluation skipped!');
            setTimeout(() => _removeBanner(), 800);
          },
        });
        break;

      case 'GROUP_EVAL_START':
        steps.push(_stepGroupEvalStart(ev, state));
        break;

      case 'SLACKER_VOTE_CAST':
        steps.push(_stepReRender(ev, state));
        break;

      case 'EVAL_VOTES_REVEALED':
        steps.push(_stepEvalVotesRevealed(ev, state));
        break;

      case 'EVAL_TIE':
        steps.push(_stepEvalTie(ev, state));
        break;

      case 'EVAL_TIE_BROKEN':
        steps.push(_stepEvalMessage(ev, state));
        break;

      case 'EVAL_CARD_REVEALED':
        steps.push(_stepEvalCardRevealed(ev, state));
        break;

      case 'EVAL_NOT_SLACKER':
        steps.push(_stepEvalNotSlacker(ev, state));
        break;

      case 'EVAL_CONFIRMED_SLACKER':
        steps.push(_stepEvalConfirmedSlacker(ev, state));
        break;

      case 'EVAL_SELF_REVEAL_OFFER':
        steps.push(_stepEvalSelfRevealOffer(ev, state));
        break;

      case 'EVAL_SELF_REVEALED':
        steps.push(_stepEvalSelfRevealed(ev, state));
        break;

      case 'EVAL_SELF_REVEAL_DECLINED':
        steps.push(_stepEvalSelfRevealDeclined(ev, state));
        break;

      case 'EVAL_ROUND_DONE':
        steps.push(_stepEvalRoundDone(ev, state));
        break;

      // ── "Who's to Blame?" fail vote + Appeal (Simple) ──
      case 'FAIL_BLAME_VOTE_START':
        steps.push(_stepFailBlameVoteStart(ev, state));
        break;

      case 'FAIL_BLAME_VOTE_CAST':
        steps.push(_stepReRender(ev, state));
        break;

      case 'FAIL_BLAME_VOTES_REVEALED':
        steps.push(_stepFailBlameVotesRevealed(ev, state));
        break;

      case 'FAIL_BLAME_TIE':
      case 'FAIL_BLAME_TIE_BROKEN':
        steps.push(_stepSimpleFailMessage(ev, state));
        break;

      case 'FAIL_BLAMED':
        steps.push(_stepFailBlamed(ev, state));
        break;

      case 'FAIL_CONFIRMED_SLACKER':
        steps.push(_stepFailConfirmedSlacker(ev, state));
        break;

      case 'FAIL_SNITCH_SUCCESS':
        steps.push(_stepFailSnitchSuccess(ev, state));
        break;

      case 'FAIL_SNITCH_FAILED':
        steps.push(_stepFailSnitchFailed(ev, state));
        break;

      case 'FAIL_SNITCH_PASSED':
        steps.push(_stepFailSnitchPassed(ev, state));
        break;

      case 'EVAL_EC_REVOKED':
        steps.push(_stepEvalECRevoked(ev, state));
        break;

      case 'FAIL_BLAME_ROUND_DONE':
        steps.push(_stepFailBlameRoundDone(ev, state));
        break;

      // ── End game ──────────────────────────────────
      case 'GAME_OVER':
        steps.push(_stepGameOver(ev, state));
        break;

      // Silently ignore: POOL_REBUILT, BLAME_SKIPPED already handled above
    }
  }

  // Always end with a full idempotent re-render to ensure DOM == state
  steps.push({
    label: 'FULL_RENDER',
    duration: 0,
    payload: { state },
    callback({ state }) {
      renderGameHeader(state);
      renderProjectPile(state);
      renderPlayersBar(state);
      renderHandFan(state, _humanId);
      renderLeadershipSkills(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      renderPlayerStatus(state, _humanId);
      renderSnitchPanel(state, _humanId);
    },
  });

  return steps;
}

// ─────────────────────────────────────────────────────
//  INDIVIDUAL STEP BUILDERS
// ─────────────────────────────────────────────────────

/* CARD_PLAYED_PROJECT / CARD_PLAYED_PARTY */
function _stepsCardPlayed(ev, state) {
  const steps = [];
  const { playerId, card } = ev;
  const isHuman   = playerId === _humanId;
  const isProject = ev.type === 'CARD_PLAYED_PROJECT';

  if (isProject) {
    steps.push({
      label: `CARD_FLY_PROJECT_${card.id}`,
      // Human: await the fly (0 duration, callback is async promise)
      // AI:    fire-and-forget with 40ms stagger so cards appear simultaneous
      duration: isHuman ? 0 : 40,
      payload: { ev, isHuman },
      callback: ({ ev, isHuman }) => {
        const { card, playerId } = ev;
        if (isHuman) {
          const el = document.querySelector(`#hand-fan [data-card-id="${card.id}"]`);
          if (el) el.classList.add('card-ghost');
          return _animCardFly(card, playerId, true);  // awaited by queue
        } else {
          _animCardFly(card, playerId, false);  // fire-and-forget
          // queue moves to next step after 40ms stagger
        }
      },
    });
  } else {
    if (isHuman) {
      steps.push({
        label: 'GHOST_PARTY_CARD',
        duration: 220,
        payload: { cardId: card.id },
        callback({ cardId }) {
          const el = document.querySelector(`#hand-fan [data-card-id="${cardId}"]`);
          if (el) el.classList.add('card-ghost');
        },
      });
    }
  }

  steps.push({
    label: `PILE_UPDATE_${ev.type}`,
    duration: 160,
    payload: { state },
    callback({ state }) {
      renderProjectPile(state);
      renderGameHeader(state);
      renderLog(state);
    },
  });

  return steps;
}

/* TURN_ADVANCED */
function _stepTurnAdvanced(ev, state) {
  return {
    label: 'TURN_ADVANCED',
    duration: 0,
    payload: { state, playerId: ev.playerId },
    callback({ state, playerId }) {
      renderGameHeader(state);
      renderPlayersBar(state);
      renderHandFan(state, _humanId);
      renderControlBar(state, _humanId);
      renderLog(state);

      const slot = document.getElementById('slot-' + playerId);
      if (slot) {
        slot.classList.add('anim-seat-glow');
        setTimeout(() => slot.classList.remove('anim-seat-glow'), 2100);
      }
    },
  };
}

/* REVEAL_START */
function _stepRevealStart(ev, state) {
  return {
    label: 'REVEAL_START',
    duration: 500,
    payload: { state },
    callback({ state }) {
      _renderPileAllFaceDown(state);
      renderGameHeader(state);
      renderControlBar(state, _humanId);
      renderLog(state);

      const pipVal = document.getElementById('effort-val');
      if (pipVal) {
        const pip = document.getElementById('effort-pip');
        if (pip) pip.classList.add('unknown');
        pipVal.textContent = '?';
      }
      // Clear skill bonus from prior semester
      setSkillBonus(0);
      const tag = document.getElementById('skill-bonus-tag');
      if (tag) tag.classList.remove('visible');
      // Reset effort bar to neutral amber (clear any pass/fail colour from prior semester)
      const track = document.querySelector('.effort-bar-track');
      if (track) track.classList.remove('outcome-pass', 'outcome-fail');
      const pip = document.getElementById('effort-pip');
      if (pip) pip.classList.remove('outcome-pass', 'outcome-fail');
    },
  };
}

/* CARD_REVEALED */
function _stepsCardRevealed(ev, state) {
  const { card } = ev;

  const flipOut = {
    label: `FLIP_OUT_${card.id}`,
    duration: 180,   // was 260 — faster reveal
    overlap: 0,
    payload: { card },
    callback({ card }) {
      const el = document.querySelector(`#project-pile [data-card-id="${card.id}"]`);
      if (!el) return;
      el.classList.add('anim-pile-flip-out');
    },
  };

  const flipIn = {
    label: `FLIP_IN_${card.id}`,
    duration: 220,   // was 320 — faster reveal
    overlap: 0,
    payload: { card },
    callback({ card }) {
      const el = document.querySelector(`#project-pile [data-card-id="${card.id}"]`);
      if (!el) return;
      el.classList.remove('card-back', 'card-mystery', 'anim-pile-flip-out');
      el.setAttribute('data-value', card.value);
      el.innerHTML = buildEffortCardHTML(card);
      el.classList.add('anim-pile-flip-in');
      el.addEventListener('animationend', () => el.classList.remove('anim-pile-flip-in'), { once: true });
    },
  };

  return [flipOut, flipIn];
}

/* EFFORT_UPDATED */
function _stepEffortUpdated(ev, state) {
  return {
    label: 'EFFORT_UPDATED',
    duration: 520,
    payload: { total: ev.total, skillBonus: ev.skillBonus || 0, skillName: ev.skillName || null },
    callback({ total, skillBonus, skillName }) {
      // Set skill bonus so renderer can split the bar green/blue
      setSkillBonus(skillBonus);
      // Start from wherever the counter currently shows — not from 0 —
      // so the number only ever counts upward during sequential card
      // reveals rather than resetting to 0 between each card flip.
      const valEl   = document.getElementById('effort-val');
      const fromVal = valEl ? (parseInt(valEl.textContent, 10) || 0) : 0;
      _animCounter(fromVal, total, 420);
      // Also update the text tag below the bar
      const tag = document.getElementById('skill-bonus-tag');
      if (tag) {
        if (skillBonus > 0 && skillName) {
          tag.textContent = '+' + skillBonus + ' effort from ' + skillName;
          tag.classList.add('visible');
        } else {
          tag.classList.remove('visible');
        }
      }
    },
  };
}

/* DEADLINE_START */
function _stepDeadlineStart(ev, state) {
  return {
    label: 'DEADLINE_START',
    duration: 800,
    payload: { state },
    callback({ state }) {
      renderGameHeader(state);
      renderPlayersBar(state);
      renderLeadershipSkills(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      _showBanner('snitch', 'Day of the Deadline — 1 card remains!');
      setTimeout(() => _removeBanner(), 700);
    },
  };
}

/* SKILL_USED */
function _stepSkillUsed(ev, state) {
  return {
    label: 'SKILL_USED',
    duration: 1200,
    payload: { skill: ev.skill, wasFaceDown: ev.wasFaceDown, state },
    callback({ skill, wasFaceDown, state }) {
      renderGameHeader(state);
      renderLog(state);
      _showBanner('pass',
        wasFaceDown
          ? `??? revealed: "${skill.name}"!`
          : `"${skill.name}" activated!`
      );
      setTimeout(() => _removeBanner(), 1000);
    },
  };
}

/* PROJECT_PASSED */
function _stepProjectPassed(ev, state) {
  return {
    label: 'PROJECT_PASSED',
    duration: 2200,
    payload: { total: ev.total, target: ev.target },
    callback({ total, target }) {
      _feltFlash('pass');
      _showBanner('pass', `Project PASSED ✓ &nbsp; ${total} / ${target}`);
      setTimeout(() => _removeBanner(), 1800);
      // Turn effort bar and pip green
      const track = document.querySelector('.effort-bar-track');
      if (track) { track.classList.remove('outcome-fail'); track.classList.add('outcome-pass'); }
      const pip = document.getElementById('effort-pip');
      if (pip) { pip.classList.remove('outcome-fail'); pip.classList.add('outcome-pass'); }
    },
  };
}

/* PROJECT_FAILED */
function _stepProjectFailed(ev, state) {
  return {
    label: 'PROJECT_FAILED',
    duration: 2000,
    payload: { total: ev.total, target: ev.target, shortfall: ev.shortfall },
    callback({ total, target, shortfall }) {
      _feltFlash('fail');
      const banner = _showBanner('fail',
        `Project FAILED ✗ &nbsp; ${total} / ${target} &nbsp;(${shortfall} short)`
      );
      if (banner) banner.classList.add('anim-shake');
      setTimeout(() => _removeBanner(), 1700);
      // Turn effort bar and pip red
      const track = document.querySelector('.effort-bar-track');
      if (track) { track.classList.remove('outcome-pass'); track.classList.add('outcome-fail'); }
      const pip = document.getElementById('effort-pip');
      if (pip) { pip.classList.remove('outcome-pass'); pip.classList.add('outcome-fail'); }
    },
  };
}

/* GROUP_FAIL — same pip animation as INDIVIDUAL_FAIL */
function _stepGroupFail(ev, state) {
  return {
    label: 'GROUP_FAIL',
    duration: 750,
    payload: { playerId: ev.playerId, failCount: ev.failCount },
    callback({ playerId, failCount }) {
      const slot = document.getElementById('slot-' + playerId);
      if (!slot) return;
      const pips = slot.querySelectorAll('.fail-pip');
      const targetPip = pips[failCount - 1];
      if (!targetPip) return;
      targetPip.style.transform = 'scale(0)';
      targetPip.style.transition = 'transform 0s';
      targetPip.classList.add('filled');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          targetPip.style.transition = 'transform 600ms cubic-bezier(0.34,1.56,0.64,1)';
          targetPip.style.transform  = 'scale(1)';
          targetPip.classList.add('anim-token-drop');
          targetPip.addEventListener('animationend', () => {
            targetPip.classList.remove('anim-token-drop');
            targetPip.style.transform  = '';
            targetPip.style.transition = '';
          }, { once: true });
        });
      });
    },
  };
}

/* INDIVIDUAL_FAIL */
function _stepIndividualFail(ev, state) {
  return {
    label: 'INDIVIDUAL_FAIL',
    duration: 750,
    payload: { playerId: ev.playerId, failCount: ev.failCount },
    callback({ playerId, failCount }) {
      const slot = document.getElementById('slot-' + playerId);
      if (!slot) return;
      const pips = slot.querySelectorAll('.fail-pip');
      const targetPip = pips[failCount - 1];
      if (!targetPip) return;
      targetPip.style.transform = 'scale(0)';
      targetPip.style.transition = 'transform 0s';
      targetPip.classList.add('filled');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          targetPip.style.transition = 'transform 600ms cubic-bezier(0.34,1.56,0.64,1)';
          targetPip.style.transform  = 'scale(1)';
          targetPip.classList.add('anim-token-drop');
          targetPip.addEventListener('animationend', () => {
            targetPip.classList.remove('anim-token-drop');
            targetPip.style.transform  = '';
            targetPip.style.transition = '';
          }, { once: true });
        });
      });
    },
  };
}

/* EXTRA_CREDIT */
function _stepExtraCredit(ev, state) {
  return {
    label: 'EXTRA_CREDIT',
    duration: 1100,
    payload: { playerId: ev.playerId, state },
    callback({ playerId, state }) {
      const slot = document.getElementById('slot-' + playerId);
      if (!slot) return;
      let credits = slot.querySelector('.slot-credits');
      if (!credits) {
        credits = document.createElement('div');
        credits.className = 'slot-credits';
        slot.appendChild(credits);
      }
      const ecImg = document.createElement('img');
      ecImg.src = './cards/extra-credit.jpg';
      ecImg.alt = 'Extra Credit';
      ecImg.className = 'ec-pip-img anim-scale-in';
      credits.appendChild(ecImg);
      // Banner showing who earned it
      const p = state.players[playerId];
      _showBanner('pass', (p ? p.name : '?') + ' earns Extra Credit!');
      setTimeout(() => _removeBanner(), 900);
    },
  };
}

/* PLAYER_EXPELLED */
function _stepPlayerExpelled(ev, state) {
  return {
    label: 'PLAYER_EXPELLED',
    duration: 1500,
    payload: { playerId: ev.playerId },
    callback({ playerId }) {
      const slot = document.getElementById('slot-' + playerId);
      if (!slot) return;
      slot.classList.add('expelled');
      if (!slot.querySelector('.expelled-stamp')) {
        const stamp = document.createElement('div');
        stamp.className = 'expelled-stamp expelled-overlay';
        stamp.textContent = 'OUT';
        slot.appendChild(stamp);
      }
    },
  };
}

/* BLAME_CAST */
function _stepBlameCast(ev, state) {
  return {
    label: 'BLAME_CAST',
    duration: 1600,
    payload: { accuserId: ev.accuserId, accusedId: ev.accusedId, state },
    callback({ accuserId, accusedId, state }) {
      renderGameHeader(state);
      renderControlBar(state, _humanId);
      renderLog(state);

      const accSlot = document.getElementById('slot-' + accuserId);
      if (accSlot) {
        accSlot.classList.add('anim-seat-glow');
        setTimeout(() => accSlot.classList.remove('anim-seat-glow'), 2100);
      }

      const acdSlot = document.getElementById('slot-' + accusedId);
      if (acdSlot) acdSlot.classList.add('accused-ring');

      _showBanner('blame',
        `${state.players[accuserId].name} blames ${state.players[accusedId].name}!`
      );
      setTimeout(() => _removeBanner(), 1400);
    },
  };
}

/* BLAME_SKIPPED */
function _stepBlameSkipped(ev, state) {
  return {
    label: 'BLAME_SKIPPED',
    duration: 400,
    payload: { state },
    callback({ state }) {
      renderGameHeader(state);
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
    },
  };
}

/* VOTING_START */
function _stepVotingStart(ev, state) {
  return {
    label: 'VOTING_START',
    duration: 600,
    payload: { state },
    callback({ state }) {
      renderGameHeader(state);
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const accused = state.blameAccusedId ? state.players[state.blameAccusedId] : null;
      _showBanner('blame', `VOTE: Was ${accused ? accused.name : 'them'} really to blame?`);
      setTimeout(() => _removeBanner(), 900);
    },
  };
}

/* VOTES_TALLIED — multi-step: blame card reveal → result banner */
function _stepsVotesTallied(ev, state) {
  const steps = [];

  // Snapshot votes at build time so the animation doesn't depend on
  // live state (safe either way since blameVotes isn't cleared until
  // semesterBreak, but explicit is better).
  const votesSnapshot = { ...(state.blameVotes || {}) };
  const voters        = Object.keys(votesSnapshot);

  // ── Step 1: set up the face-down blame card row ──────────
  steps.push({
    label:    'BLAME_REVEAL_SETUP',
    duration: 320,
    payload:  { voters, state },
    callback({ voters, state }) {
      // Remove any lingering reveal area from a previous round
      document.getElementById('blame-reveal-area')?.remove();
      if (voters.length === 0) return;

      const area = document.createElement('div');
      area.id        = 'blame-reveal-area';
      area.className = 'blame-reveal-area';

      for (const vid of voters) {
        const vname = state.players[vid]?.name ?? '?';
        const card  = document.createElement('div');
        card.className  = 'blame-reveal-card';
        card.id         = 'blame-rev-' + vid;
        card.innerHTML  =
          `<img src="./cards/blame-card-back.jpg" alt="Vote card" class="blame-card-img">` +
          `<div class="blame-voter-name">${vname}</div>`;
        area.appendChild(card);
      }
      document.body.appendChild(area);
    },
  });

  // ── Steps 2…N: flip each voter's card one by one ────────
  for (const vid of voters) {
    const isAccused = votesSnapshot[vid] === ev.accusedId;
    steps.push({
      label:    `BLAME_FLIP_${vid}`,
      duration: 240,   // fast, no pause on last card
      overlap:  0,
      payload:  { vid, isAccused },
      callback({ vid, isAccused }) {
        const card = document.getElementById('blame-rev-' + vid);
        if (!card) return;
        // Flip out
        card.classList.add('anim-pile-flip-out');
        // Halfway through — swap to face artwork
        setTimeout(() => {
          card.classList.remove('anim-pile-flip-out');
          const imgSrc = isAccused
            ? './cards/blame-accused.jpg'
            : './cards/blame-leader.jpg';
          const nameEl = card.querySelector('.blame-voter-name');
          const vname  = nameEl?.textContent ?? '';
          card.innerHTML =
            `<img src="${imgSrc}" alt="${isAccused ? 'Blamed accused' : 'Blamed leader'}" class="blame-card-img">` +
            `<div class="blame-voter-name">${vname}</div>`;
          card.classList.add('anim-pile-flip-in');
          card.addEventListener('animationend',
            () => card.classList.remove('anim-pile-flip-in'),
            { once: true });
        }, 120);
      },
    });
  }

  // ── Final step: remove reveal area, show vote-result banner ─
  steps.push({
    label:    'VOTES_TALLIED',
    duration: 1400,
    payload:  { ev, state },
    callback({ ev, state }) {
      setTimeout(() => document.getElementById('blame-reveal-area')?.remove(), 600);

      renderGameHeader(state);
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);

      const counts  = ev.voteCounts || {};
      const aV      = counts[ev.accusedId] || 0;
      const lV      = counts[ev.leaderId]  || 0;
      const accused = ev.accusedId ? state.players[ev.accusedId] : null;
      const leader  = ev.leaderId  ? state.players[ev.leaderId]  : null;

      let msg;
      if (aV > lV) {
        msg = `Vote result: ${accused?.name ?? 'Accused'} (${aV}) — takes the fail!`;
      } else if (lV > aV) {
        msg = `Vote result: ${leader?.name ?? 'Leader'} (${lV}) — takes the fail!`;
      } else {
        msg = `Tied vote! Investigation — comparing Party Pile cards.`;
      }
      _showBanner(aV !== lV ? 'fail' : 'snitch', msg);
      setTimeout(() => _removeBanner(), 1200);
    },
  });

  return steps;
}

/* TIE_INVESTIGATION */
function _stepTieInvestigation(ev, state) {
  return {
    label: 'TIE_INVESTIGATION',
    duration: 1200,
    payload: { ev, state },
    callback({ ev, state }) {
      renderLog(state);
      const accused = ev.accusedId ? state.players[ev.accusedId] : null;
      const leader  = ev.leaderId  ? state.players[ev.leaderId]  : null;
      const aV      = ev.accusedCard ? ev.accusedCard.value : '?';
      const lV      = ev.leaderCard  ? ev.leaderCard.value  : '?';
      _showBanner('snitch',
        `Tie — ${accused?.name ?? '?'} shows ${aV} vs ${leader?.name ?? '?'} shows ${lV}`
      );
      setTimeout(() => _removeBanner(), 1100);
    },
  };
}

/* SNITCH_PHASE_START */
function _stepSnitchPhaseStart(ev, state) {
  return {
    label: 'SNITCH_PHASE_START',
    duration: 800,
    payload: { ev, state },
    callback({ ev, state }) {
      renderGameHeader(state);
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      renderSnitchPanel(state, _humanId);
      const snitcher = ev.snitcherId ? state.players[ev.snitcherId] : null;
      _showBanner('snitch', `${snitcher?.name ?? '?'} can now start a Snitch chain`);
      setTimeout(() => _removeBanner(), 700);
    },
  };
}

/* SNITCH_REVEALED — show target's party card popping up */
function _stepSnitchRevealed(ev, state) {
  return {
    label: 'SNITCH_REVEALED',
    duration: 800,
    payload: { targetId: ev.targetId, card: ev.targetCard, state },
    callback({ targetId, card, state }) {
      renderLog(state);
      const slot = document.getElementById('slot-' + targetId);
      if (slot && card) {
        const badge = document.createElement('div');
        badge.className = 'snitch-card-badge anim-scale-in';
        badge.textContent = card.value === 'copy' ? 'X2' : card.value;
        badge.title = `Party card: ${card.name ?? card.value}`;
        slot.appendChild(badge);
      }
    },
  };
}

/* SNITCH_SUCCESS / SNITCH_FAIL */
function _stepSnitchResult(ev, state, isSuccess) {
  return {
    label: ev.type,
    duration: 1800,
    payload: { ev, state, isSuccess },
    callback({ ev, state, isSuccess }) {
      // Remove the card badge from the target slot
      const targetSlot = document.getElementById('slot-' + ev.targetId);
      if (targetSlot) {
        targetSlot.classList.remove('accused-ring');
        targetSlot.querySelector('.snitch-card-badge')?.remove();
      }
      renderLog(state);
      renderControlBar(state, _humanId);

      const target  = ev.targetId   ? state.players[ev.targetId]   : null;
      const snitch  = ev.snitcherId ? state.players[ev.snitcherId] : null;
      _showBanner(
        isSuccess ? 'pass' : 'fail',
        isSuccess
          ? `SNITCH SUCCEEDS! ${target?.name ?? '?'} caught out — takes a fail!`
          : `SNITCH FAILS — ${snitch?.name ?? '?'} loses their top 2 cards!`
      );
      setTimeout(() => _removeBanner(), 1600);
    },
  };
}

/* SNITCH_PASSED — snitcher chose to end the chain */
function _stepSnitchPassed(ev, state) {
  return {
    label: 'SNITCH_PASSED',
    duration: 900,
    payload: { snitcherId: ev.snitcherId, state },
    callback({ snitcherId, state }) {
      const slot = document.getElementById('slot-' + snitcherId);
      if (slot) slot.classList.remove('accused-ring');
      slot?.querySelector('.snitch-card-badge')?.remove();
      renderLog(state);
      _showBanner('snitch',
        `${snitcherId && state.players[snitcherId] ? state.players[snitcherId].name : '?'} passes — snitch chain ends.`
      );
      setTimeout(() => _removeBanner(), 800);
    },
  };
}

/* SEMESTER_BREAK_START */
function _stepSemesterBreakStart(ev, state) {
  return {
    label: 'SEMESTER_BREAK_START',
    duration: 1200,
    payload: { ev, state },
    callback({ ev, state }) {
      renderGameHeader(state);
      renderPlayersBar(state);
      renderHandFan(state, _humanId);
      renderControlBar(state, _humanId);
      renderLog(state);
      _showBanner('pass', 'Semester Break! Each player draws a new pair.');
      setTimeout(() => _removeBanner(), 1000);
    },
  };
}

/* PAIR_DRAWN — show new cards flying into human's hand */
function _stepPairDrawn(ev, state) {
  return {
    label: 'PAIR_DRAWN',
    duration: 240,
    overlap: 60,
    payload: { playerId: ev.playerId, cards: ev.cards ?? [], state },
    callback({ playerId, cards, state }) {
      if (playerId !== _humanId) {
        // AI: update party pile badge
        const slot = document.getElementById('slot-' + playerId);
        if (slot) {
          const p       = state.players[playerId];
          const partyEl = slot.querySelector('.slot-party');
          if (partyEl) partyEl.innerHTML = `<img src="./cards/Card Back Regular.jpg" alt="cards" class="party-pile-back"/><span class="party-pile-count">${p.partyPile.length}</span>`;
        }
        return;
      }

      // Human: re-render hand, then animate each new card
      renderHandFan(state, _humanId);
      if (!cards.length) return;

      const poolEl = document.querySelector('.pool-badge') || document.getElementById('effort-pip');

      for (const c of cards) {
        const newEl = document.querySelector(`#hand-fan [data-card-id="${c.id}"]`);
        if (!newEl) continue;

        if (poolEl) {
          const src = poolEl.getBoundingClientRect();
          const dst = newEl.getBoundingClientRect();
          newEl.style.setProperty('--sx',
            `${(src.left + src.width  / 2) - (dst.left + dst.width  / 2)}px`
          );
          newEl.style.setProperty('--sy',
            `${(src.top  + src.height / 2) - (dst.top  + dst.height / 2)}px`
          );
        } else {
          newEl.style.setProperty('--sx', '0px');
          newEl.style.setProperty('--sy', '-120px');
        }

        newEl.classList.add('anim-card-deal');
        newEl.addEventListener('animationend', () => {
          newEl.classList.remove('anim-card-deal');
          newEl.style.removeProperty('--sx');
          newEl.style.removeProperty('--sy');
        }, { once: true });
      }
    },
  };
}

/* SEMESTER_START */
function _stepSemesterStart(ev, state) {
  return {
    label: 'SEMESTER_START',
    duration: 600,
    payload: { state },
    callback({ state }) {
      renderGameHeader(state);
      renderLog(state);
      _showBanner('pass',
        `Semester ${state.semester} — target: ${state.projectTarget}`
      );
      setTimeout(() => _removeBanner(), 900);
    },
  };
}

/* GROUP_EVAL_START */
function _stepGroupEvalStart(ev, state) {
  return {
    label: 'GROUP_EVAL_START',
    duration: 1000,
    payload: { ev, state },
    callback({ ev, state }) {
      renderGameHeader(state);
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      // GROUP_EVAL only ever runs after a PASS (without Extra Credit) now —
      // a FAIL goes through the separate "Who's to Blame?" flow instead.
      _showBanner('pass', 'The project PASSED. Group Evaluation begins!');
      setTimeout(() => _removeBanner(), 900);
    },
  };
}

/* EVAL_VOTES_REVEALED — blocking modal showing the vote tally */
function _stepEvalVotesRevealed(ev, state) {
  return {
    label: 'EVAL_VOTES_REVEALED',
    duration: 0,
    payload: { ev, state },
    async callback({ ev, state }) {
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      await _showVoteResultsModal({
        title:   'Group Evaluation — Votes Revealed',
        intro:   'Each Slacker card placed this round:',
        counts:  ev.counts,
        state,
        cardImg: './cards/voting-card.jpg',
      });
    },
  };
}

/* EVAL_TIE */
function _stepEvalTie(ev, state) {
  return {
    label: 'EVAL_TIE',
    duration: 900,
    payload: { ev, state },
    callback({ ev, state }) {
      renderControlBar(state, _humanId);
      renderLog(state);
      _showBanner('blame', `Tied vote! ${state.players[ev.leaderId]?.name ?? 'Leader'} must break the tie.`);
      setTimeout(() => _removeBanner(), 800);
    },
  };
}

/* Generic Group Eval message events */
function _stepEvalMessage(ev, state) {
  const bannerMap = {
    EVAL_TIE_BROKEN: 'blame',
  };
  return {
    label: ev.type,
    duration: 1100,
    payload: { ev, state },
    callback({ ev, state }) {
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const type   = bannerMap[ev.type] ?? 'blame';
      const logEntry = state.log[state.log.length - 1];
      if (logEntry) {
        _showBanner(type, logEntry.text);
        setTimeout(() => _removeBanner(), 1000);
      }
    },
  };
}

/* EVAL_CARD_REVEALED — show the voted player's party card badge */
function _stepEvalCardRevealed(ev, state) {
  return {
    label: 'EVAL_CARD_REVEALED',
    duration: 1200,
    payload: { ev, state },
    callback({ ev, state }) {
      document.querySelectorAll('.snitch-card-badge').forEach(el => el.remove());
      renderPlayersBar(state);
      renderLog(state);
      const player = state.players[ev.playerId];
      const slot   = document.getElementById('slot-' + ev.playerId);
      if (slot && ev.card) {
        const badge = document.createElement('div');
        badge.className = 'snitch-card-badge anim-scale-in';
        badge.textContent = ev.card.type === 'copy' ? 'X2' : ev.card.value;
        badge.title = `Party card: ${ev.card.name ?? ev.card.value}`;
        slot.appendChild(badge);
      }
      _showBanner('snitch', `${player?.name ?? '?'} reveals Party card: ${ev.partyVal}`);
      setTimeout(() => _removeBanner(), 1100);
    },
  };
}

/* EVAL_NOT_SLACKER — voted player is not the slacker */
function _stepEvalNotSlacker(ev, state) {
  return {
    label: 'EVAL_NOT_SLACKER',
    duration: 1400,
    payload: { ev, state },
    callback({ ev, state }) {
      const player = state.players[ev.playerId];
      renderLog(state);
      _showBanner('blame', `${player?.name ?? '?'} (${ev.partyVal}) is NOT the highest (max ${ev.maxVal}) — evaluation fails!`);
      setTimeout(() => _removeBanner(), 1200);
    },
  };
}

/* EVAL_CONFIRMED_SLACKER — blocking popup + confetti */
function _stepEvalConfirmedSlacker(ev, state) {
  return {
    label: 'EVAL_CONFIRMED_SLACKER',
    duration: 0,
    payload: { ev, state },
    async callback({ ev, state }) {
      document.querySelectorAll('.snitch-card-badge').forEach(el => el.remove());
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const slacker = state.players[ev.slackerId];
      _launchConfetti();
      await _showSlackerFoundModal(slacker?.name ?? '?', 'Discards their top Party card at round\'s end.', 'IS THE SLACKER!', './cards/voting-card.jpg');
    },
  };
}

/* EVAL_SELF_REVEAL_OFFER — the real slacker may reveal themselves */
function _stepEvalSelfRevealOffer(ev, state) {
  return {
    label: 'EVAL_SELF_REVEAL_OFFER',
    duration: 1000,
    payload: { ev, state },
    callback({ ev, state }) {
      document.querySelectorAll('.snitch-card-badge').forEach(el => el.remove());
      renderControlBar(state, _humanId);
      renderPlayersBar(state);
      renderLog(state);
      _showBanner('snitch', 'The real Slacker may now reveal themselves for +5 points!');
      setTimeout(() => _removeBanner(), 900);
    },
  };
}

/* EVAL_SELF_REVEALED — blocking popup + confetti */
function _stepEvalSelfRevealed(ev, state) {
  return {
    label: 'EVAL_SELF_REVEALED',
    duration: 0,
    payload: { ev, state },
    async callback({ ev, state }) {
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const slacker = state.players[ev.slackerId];
      _launchConfetti();
      await _showSlackerFoundModal(slacker?.name ?? '?', '+5 Successful Slack Off card earned!', 'REVEALED THEMSELVES!', './cards/successful-slack-off.jpg');
    },
  };
}

/* EVAL_SELF_REVEAL_DECLINED */
function _stepEvalSelfRevealDeclined(ev, state) {
  return {
    label: 'EVAL_SELF_REVEAL_DECLINED',
    duration: 900,
    payload: { ev, state },
    callback({ ev, state }) {
      renderControlBar(state, _humanId);
      renderLog(state);
      _showBanner('blame', 'The Slacker stays hidden.');
      setTimeout(() => _removeBanner(), 800);
    },
  };
}

/* EVAL_ROUND_DONE */
function _stepEvalRoundDone(ev, state) {
  return {
    label: 'EVAL_ROUND_DONE',
    duration: 800,
    payload: { ev, state },
    callback({ ev, state }) {
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      _showBanner('pass', 'Group Evaluation complete.');
      setTimeout(() => _removeBanner(), 700);
    },
  };
}

/* FAIL_BLAME_VOTE_START */
function _stepFailBlameVoteStart(ev, state) {
  return {
    label: 'FAIL_BLAME_VOTE_START',
    duration: 1000,
    payload: { ev, state },
    callback({ ev, state }) {
      renderGameHeader(state);
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      _showBanner('fail', `The project FAILED. Who's to Blame? voting begins!`);
      setTimeout(() => _removeBanner(), 900);
    },
  };
}

/* FAIL_BLAME_VOTES_REVEALED — blocking modal showing the vote tally */
function _stepFailBlameVotesRevealed(ev, state) {
  return {
    label: 'FAIL_BLAME_VOTES_REVEALED',
    duration: 0,
    payload: { ev, state },
    async callback({ ev, state }) {
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      await _showVoteResultsModal({
        title:   "Who's to Blame? — Votes Revealed",
        intro:   'Each Fail vote cast this round:',
        counts:  ev.counts,
        state,
        cardImg: './cards/other/Fail1.jpg',
      });
    },
  };
}

/* Generic narrative events for the fail vote tie break */
function _stepSimpleFailMessage(ev, state) {
  const bannerMap = {
    FAIL_BLAME_TIE:        'blame',
    FAIL_BLAME_TIE_BROKEN: 'blame',
  };
  return {
    label: ev.type,
    duration: 1100,
    payload: { ev, state },
    callback({ ev, state }) {
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const type     = bannerMap[ev.type] ?? 'blame';
      const logEntry = state.log[state.log.length - 1];
      if (logEntry) {
        _showBanner(type, logEntry.text);
        setTimeout(() => _removeBanner(), 1000);
      }
    },
  };
}

/* FAIL_BLAMED — vote-winner reveals their Party card and always discards */
function _stepFailBlamed(ev, state) {
  return {
    label: 'FAIL_BLAMED',
    duration: 1300,
    payload: { blamedId: ev.blamedId, card: ev.card, isSlacker: ev.isSlacker, partyVal: ev.partyVal, state },
    callback({ blamedId, card, isSlacker, partyVal, state }) {
      document.querySelectorAll('.snitch-card-badge').forEach(el => el.remove());
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const slot = document.getElementById('slot-' + blamedId);
      if (slot && card) {
        const badge = document.createElement('div');
        badge.className = 'snitch-card-badge anim-scale-in';
        badge.textContent = card.type === 'copy' ? 'X2' : card.value;
        badge.title = `Party card: ${card.name ?? card.value}`;
        slot.appendChild(badge);
      }
      const blamed = state.players[blamedId];
      _showBanner('fail', `${blamed?.name ?? '?'} reveals Party card (${partyVal}) — discards it!`);
      setTimeout(() => _removeBanner(), 1200);
    },
  };
}

/* FAIL_CONFIRMED_SLACKER — blocking popup + confetti (blamed IS the slacker) */
function _stepFailConfirmedSlacker(ev, state) {
  return {
    label: 'FAIL_CONFIRMED_SLACKER',
    duration: 0,
    payload: { ev, state },
    async callback({ ev, state }) {
      document.querySelectorAll('.snitch-card-badge').forEach(el => el.remove());
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const slacker = state.players[ev.blamedId];
      _launchConfetti();
      await _showSlackerFoundModal(slacker?.name ?? '?', 'Individual Fail + discards their top Party card.', 'IS THE SLACKER!', './cards/voting-card.jpg');
    },
  };
}

/* EVAL_EC_REVOKED — leader's gift EC is taken away */
function _stepEvalECRevoked(ev, state) {
  return {
    label: 'EVAL_EC_REVOKED',
    duration: 1100,
    payload: { ev, state },
    callback({ ev, state }) {
      renderPlayersBar(state);
      renderLog(state);
      const recipient = state.players[ev.recipientId];
      _showBanner('fail', `${recipient?.name ?? '?'}'s Extra Credit from this round is REVOKED — the Slacker was caught!`);
      setTimeout(() => _removeBanner(), 1000);
    },
  };
}

/* FAIL_SNITCH_SUCCESS — target's card revealed, chain continues */
function _stepFailSnitchSuccess(ev, state) {
  return {
    label: 'FAIL_SNITCH_SUCCESS',
    duration: 1400,
    payload: { ev, state },
    callback({ ev, state }) {
      document.querySelectorAll('.snitch-card-badge').forEach(el => el.remove());
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const target = state.players[ev.targetId];
      const slot   = document.getElementById('slot-' + ev.targetId);
      if (slot && ev.targetCard) {
        const badge = document.createElement('div');
        badge.className = 'snitch-card-badge anim-scale-in';
        badge.textContent = ev.targetCard.type === 'copy' ? 'X2' : ev.targetCard.value;
        badge.title = `Party card: ${ev.targetCard.name ?? ev.targetCard.value}`;
        slot.appendChild(badge);
      }
      _showBanner('blame', `SNITCH SUCCEEDS! ${target?.name ?? '?'} (${ev.targetVal}) caught — discards their card! Chain continues.`);
      setTimeout(() => _removeBanner(), 1300);
    },
  };
}

/* FAIL_SNITCH_FAILED — target's card revealed, snitcher penalised */
function _stepFailSnitchFailed(ev, state) {
  return {
    label: 'FAIL_SNITCH_FAILED',
    duration: 1400,
    payload: { ev, state },
    callback({ ev, state }) {
      document.querySelectorAll('.snitch-card-badge').forEach(el => el.remove());
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const target  = state.players[ev.targetId];
      const snitcher = state.players[ev.snitcherId];
      const slot   = document.getElementById('slot-' + ev.targetId);
      if (slot && ev.targetCard) {
        const badge = document.createElement('div');
        badge.className = 'snitch-card-badge anim-scale-in';
        badge.textContent = ev.targetCard.type === 'copy' ? 'X2' : ev.targetCard.value;
        badge.title = `Party card: ${ev.targetCard.name ?? ev.targetCard.value}`;
        slot.appendChild(badge);
      }
      const penalty = ev.penalty === 'ec' ? '−1 Extra Credit' : ev.penalty === 'sso' ? '−1 Slack Off card' : 'no penalty (nothing to lose)';
      _showBanner('fail', `Snitch FAILS — ${target?.name ?? '?'} (${ev.targetVal}) not higher. ${snitcher?.name ?? '?'} pays: ${penalty}.`);
      setTimeout(() => _removeBanner(), 1300);
    },
  };
}

/* FAIL_SNITCH_PASSED — chain holder passes, chain ends */
function _stepFailSnitchPassed(ev, state) {
  return {
    label: 'FAIL_SNITCH_PASSED',
    duration: 900,
    payload: { ev, state },
    callback({ ev, state }) {
      document.querySelectorAll('.snitch-card-badge').forEach(el => el.remove());
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      const snitcher = state.players[ev.snitcherId];
      _showBanner('snitch', `${snitcher?.name ?? '?'} passes — snitch chain ends.`);
      setTimeout(() => _removeBanner(), 800);
    },
  };
}

/* FAIL_BLAME_ROUND_DONE */
function _stepFailBlameRoundDone(ev, state) {
  return {
    label: 'FAIL_BLAME_ROUND_DONE',
    duration: 800,
    payload: { ev, state },
    callback({ ev, state }) {
      document.querySelectorAll('.snitch-card-badge').forEach(el => el.remove());
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      _showBanner('pass', 'Round resolved.');
      setTimeout(() => _removeBanner(), 700);
    },
  };
}

/* GAME_OVER */
function _stepGameOver(ev, state) {
  return {
    label: 'GAME_OVER',
    duration: 1200,
    payload: { ev, state },
    callback({ ev, state }) {
      renderGameHeader(state);
      renderControlBar(state, _humanId);
      renderLog(state);

      const reason = ev.gameEndReason ?? state.gameEndReason;
      let bannerText;
      if (reason === 'all-expelled') {
        bannerText = 'Everyone expelled — Game Over!';
      } else if (reason === 'elimination-limit') {
        bannerText = 'Eliminations end the game — Game Over!';
      } else {
        bannerText = 'All semesters complete — Game Over!';
      }
      _showBanner('pass', bannerText);
      setTimeout(() => _removeBanner(), 1100);
      _launchConfetti();
    },
  };
}

/* Generic re-render for events that don't need special animation */
function _stepReRender(ev, state) {
  return {
    label: ev.type,
    duration: 120,
    payload: { state },
    callback({ state }) {
      renderGameHeader(state);
      renderPlayersBar(state);
      renderControlBar(state, _humanId);
      renderLog(state);
    },
  };
}

// ─────────────────────────────────────────────────────
//  ANIMATION HELPERS
// ─────────────────────────────────────────────────────

function _renderPileAllFaceDown(state) {
  const container = document.getElementById('project-pile');
  if (!container) return;
  container.innerHTML = '';

  state.projectPile.forEach((card, i) => {
    const rot = PILE_ROTS[i % PILE_ROTS.length];
    const el  = document.createElement('div');
    el.className           = 'card card-sm no-interact card-back';
    el.dataset.cardId      = card.id;
    el.dataset.pileIdx     = i;
    el.style.setProperty('--rot', `${rot}deg`);
    el.style.transform     = `rotate(${rot}deg)`;
    el.setAttribute('aria-label', 'Face-down card');
    if (i === state.projectPile.length - 1) el.classList.add('card-mystery');
    container.appendChild(el);
  });
}

function _animCounter(fromVal, toVal, durationMs) {
  const start = performance.now();
  const tick  = (now) => {
    const t       = Math.min((now - start) / durationMs, 1);
    const eased   = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const current = Math.round(fromVal + (toVal - fromVal) * eased);
    renderEffortCounter(current);
    if (t < 1) requestAnimationFrame(tick);
    else        renderEffortCounter(toVal);
  };
  requestAnimationFrame(tick);
}

function _feltFlash(type) {
  const el = document.createElement('div');
  el.className = `felt-flash ${type}`;
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

function _showBanner(type, html) {
  _removeBanner();
  const banner = document.createElement('div');
  banner.id        = 'anim-banner';
  banner.className = `phase-banner ${type} anim-banner-in`;
  banner.innerHTML = html;
  document.body.appendChild(banner);
  return banner;
}

function _removeBanner() {
  const old = document.getElementById('anim-banner');
  if (!old) return;
  old.classList.remove('anim-banner-in');
  old.classList.add('anim-banner-out');
  old.addEventListener('animationend', () => old.remove(), { once: true });
}

function _esc(str) {
  return String(str ?? '').replace(/[<>&"]/g, c =>
    ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c])
  );
}

// ── Blocking vote-results modal — used by both the Group Evaluation
// (Slacker vote) and "Who's to Blame?" (Fail vote) flows. Resolves the
// returned Promise when the player clicks Continue, pausing the queue.
function _showVoteResultsModal({ title, intro, counts, state, cardImg }) {
  return new Promise(resolve => {
    document.getElementById('vote-results-overlay')?.remove();

    const entries = Object.entries(counts || {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);

    const rows = entries.length > 0
      ? entries.map(([id, n]) => {
          const p = state.players[id];
          return `<div class="vote-result-row">
            <img src="${cardImg}" alt="" class="vote-result-img"/>
            <div class="vote-result-name">${_esc(p?.name ?? id)}</div>
            <div class="vote-result-count">${n} vote${n !== 1 ? 's' : ''}</div>
          </div>`;
        }).join('')
      : `<div class="vote-result-row"><div class="vote-result-name">No votes cast</div></div>`;

    const overlay = document.createElement('div');
    overlay.id        = 'vote-results-overlay';
    overlay.className = 'overlay-screen active';
    overlay.innerHTML = `
      <div class="overlay-sheet vote-results-sheet">
        <div class="overlay-title">${_esc(title)}</div>
        ${intro ? `<div class="overlay-body">${_esc(intro)}</div>` : ''}
        <div class="vote-results-list">${rows}</div>
        <button class="btn-p" id="vr-continue">Continue</button>
      </div>`;

    overlay.querySelector('#vr-continue').addEventListener('click', () => {
      overlay.remove();
      resolve();
    });
    document.body.appendChild(overlay);
  });
}

// ── Blocking popup — used for confirmed slacker and self-reveal.
// titleSuffix defaults to "IS THE SLACKER!" but can be overridden.
function _showSlackerFoundModal(name, bodyText, titleSuffix = 'IS THE SLACKER!', cardImg = './cards/voting-card.jpg') {
  return new Promise(resolve => {
    document.getElementById('slacker-found-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'slacker-found-overlay';
    overlay.className = 'overlay-screen active';
    overlay.innerHTML = `
      <div class="overlay-sheet slacker-found-sheet">
        <img src="${cardImg}" alt="Card" class="slacker-found-img"/>
        <div class="slacker-found-title">${_esc(name)} ${_esc(titleSuffix)}</div>
        <div class="overlay-body">${_esc(bodyText)}</div>
        <button class="btn-p" id="sf-continue">Continue</button>
      </div>`;

    overlay.querySelector('#sf-continue').addEventListener('click', () => {
      overlay.remove();
      resolve();
    });
    document.body.appendChild(overlay);
  });
}

// ─────────────────────────────────────────────────────
//  CARD FLY ANIMATION
// ─────────────────────────────────────────────────────

const CARD_SM_W = 70;
const CARD_SM_H = 106;

async function _animCardFly(card, playerId, isHuman) {
  let srcEl = null;
  if (isHuman) {
    srcEl = document.querySelector(`#hand-fan [data-card-id="${card.id}"]`);
  }
  if (!srcEl) srcEl = document.getElementById('slot-' + playerId);

  const destEl = document.getElementById('project-pile');
  if (!srcEl || !destEl) return;

  const srcRect  = srcEl.getBoundingClientRect();
  const destRect = destEl.getBoundingClientRect();

  const srcCX  = srcRect.left  + srcRect.width  / 2;
  const srcCY  = srcRect.top   + srcRect.height / 2;
  const destCX = destRect.left + destRect.width  / 2;
  const destCY = destRect.top  + destRect.height / 2;

  const pileLen = destEl.querySelectorAll('[data-card-id]').length;
  const rot     = PILE_ROTS[pileLen % PILE_ROTS.length];

  const clone = document.createElement('div');
  clone.className = 'card card-sm card-flying no-interact';

  if (isHuman) {
    clone.setAttribute('data-value', card.value);
    clone.innerHTML = buildEffortCardHTML(card);
  } else {
    clone.classList.add('card-back');
  }

  clone.style.left = (srcCX - CARD_SM_W / 2) + 'px';
  clone.style.top  = (srcCY - CARD_SM_H / 2) + 'px';
  clone.style.setProperty('--mx',  `${destCX - srcCX}px`);
  clone.style.setProperty('--my',  `${destCY - srcCY}px`);
  clone.style.setProperty('--rot', `${rot}deg`);

  document.body.appendChild(clone);

  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  clone.classList.add('anim-card-arc');

  await sleep(isHuman ? 520 : 180);
  clone.remove();
}

// ─────────────────────────────────────────────────────
//  CONFETTI
// ─────────────────────────────────────────────────────

function _launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const COLORS = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
    '#9b59b6', '#d4af37', '#e91e8c', '#1abc9c',
  ];

  const particles = Array.from({ length: 200 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 9 + 3;
    return {
      x:     canvas.width / 2 + (Math.random() - 0.5) * canvas.width * 0.5,
      y:     -20,
      vx:    Math.cos(angle) * speed * 0.6,
      vy:    Math.sin(angle) * speed * 0.4 - 3,
      rot:   Math.random() * 360,
      rotV:  (Math.random() - 0.5) * 14,
      w:     Math.random() * 10 + 4,
      h:     Math.random() * 5  + 3,
      col:   COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: 1,
      decay: Math.random() * 0.005 + 0.003,
    };
  });

  let start = null;
  const DURATION = 4200;

  function frame(ts) {
    if (!start) start = ts;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let anyAlive = false;
    for (const p of particles) {
      p.vy    += 0.18;
      p.vx    *= 0.993;
      p.x     += p.vx;
      p.y     += p.vy;
      p.rot   += p.rotV;
      p.alpha -= p.decay;
      if (p.alpha <= 0) continue;
      anyAlive = true;

      ctx.save();
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.fillStyle = p.col;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (anyAlive && (ts - start) < DURATION) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  requestAnimationFrame(frame);
}
