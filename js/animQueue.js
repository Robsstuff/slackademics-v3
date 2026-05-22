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

  while (_queue.length > 0) {
    const step = _queue.shift();
    try {
      await Promise.resolve(step.callback(step.payload ?? {}));
    } catch (err) {
      console.error(`[AnimQueue] step "${step.label}" threw:`, err);
    }
    const wait = Math.max(0, (step.duration ?? 0) - (step.overlap ?? 0));
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
        steps.push(_stepVotesTallied(ev, state));
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
      duration: 0,
      payload: { ev, isHuman },
      callback: async ({ ev, isHuman }) => {
        const { card, playerId } = ev;
        if (isHuman) {
          const el = document.querySelector(`#hand-fan [data-card-id="${card.id}"]`);
          if (el) el.classList.add('card-ghost');
        }
        await _animCardFly(card, playerId, isHuman);
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
    duration: 140,
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
    },
  };
}

/* CARD_REVEALED */
function _stepsCardRevealed(ev, state) {
  const { card } = ev;

  const flipOut = {
    label: `FLIP_OUT_${card.id}`,
    duration: 260,
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
    duration: 320,
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
    duration: 420,
    payload: { total: ev.total },
    callback({ total }) {
      _animCounter(total - ev.total > 8 ? total - ev.total : 0, total, 380);
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
    duration: 600,
    payload: { playerId: ev.playerId },
    callback({ playerId }) {
      const slot = document.getElementById('slot-' + playerId);
      if (!slot) return;
      let credits = slot.querySelector('.slot-credits');
      if (!credits) {
        credits = document.createElement('div');
        credits.className = 'slot-credits';
        slot.appendChild(credits);
      }
      const star = document.createElement('span');
      star.textContent = '★';
      star.style.display = 'inline-block';
      star.classList.add('anim-scale-in');
      credits.appendChild(star);
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

/* VOTES_TALLIED */
function _stepVotesTallied(ev, state) {
  return {
    label: 'VOTES_TALLIED',
    duration: 1200,
    payload: { ev, state },
    callback({ ev, state }) {
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
      setTimeout(() => _removeBanner(), 1100);
    },
  };
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
          if (partyEl) partyEl.innerHTML = `&#128128;&thinsp;${p.partyPile.length}`;
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

/* GAME_OVER */
function _stepGameOver(ev, state) {
  return {
    label: 'GAME_OVER',
    duration: 1200,
    payload: { state },
    callback({ state }) {
      renderGameHeader(state);
      renderControlBar(state, _humanId);
      renderLog(state);
      _showBanner('pass', 'All semesters complete — Game Over!');
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
