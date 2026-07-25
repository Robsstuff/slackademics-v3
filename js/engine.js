/* =====================================================
   SLACKADEMICS — Game Engine (Rulebook v2)
   Pure game rules. Mutates state in-place and returns
   GameEvent[] describing what happened. NO DOM access.

   Phases: PLAYING → REVEAL → DEADLINE →
     (pass) → BREAK [→ BREAK_DRAW] → PLAYING ...
     (fail) → BLAME → BLAME_VOTE → SNITCH → BREAK ...
     (end)  → GAMEOVER

   Event types:
     CARD_PLAYED_PROJECT   CARD_PLAYED_PARTY   TURN_ADVANCED
     REVEAL_START          CARD_REVEALED       EFFORT_UPDATED
     DEADLINE_START        SKILL_USED          SKILL_NEEDS_TARGET
     REALIGN_SWAP          CARDS_REMOVED
     PROJECT_PASSED        PROJECT_FAILED
     GROUP_FAIL            INDIVIDUAL_FAIL     PLAYER_EXPELLED
     EXTRA_CREDIT          BLAME_CAST          VOTING_START
     VOTE_CAST             VOTES_TALLIED       TIE_INVESTIGATION
     BLAME_SKIPPED         SNITCH_PHASE_START  SNITCH_REVEALED
     SNITCH_SUCCESS        SNITCH_FAIL         SNITCH_DISCARD
     SNITCH_PASSED         PARTY_CARDS_DISCARDED
     SEMESTER_BREAK_START  PAIR_DRAWN          BREAK_DRAW_NEXT
     SEMESTER_START        GAME_OVER
   ===================================================== */
'use strict';

import {
  addLog, getTarget, getSimpleTarget, totalFails,
  FAIL_LIMIT, TOTAL_SEMESTERS, BREAK_SEMESTERS,
  SEMESTER_NAMES, SIMPLE_SEMESTER_NAMES, POOL_PAIRS, makeCard,
} from './state.js?v=6';
import { shuffle } from './utils.js?v=6';

// ── Event factory ─────────────────────────────────────────
function evt(type, payload = {}) { return { type, ...payload }; }

// ── Active (non-expelled) players in turn order ───────────
export function activePlayers(state) {
  return state.playerOrder.filter(id => !state.players[id].isExpelled);
}

// ── Next active player after currentId ───────────────────
export function nextPlayer(state, currentId) {
  const order = activePlayers(state);
  const idx   = order.indexOf(currentId);
  return order[(idx + 1) % order.length];
}

// ── Pair validation ───────────────────────────────────────
export function isValidPair(c1, c2) {
  if (!c1 || !c2 || c1.id === c2.id) return false;
  if (c1.type === 'copy'   && c2.type === 'copy')   return true;
  if (c1.type === 'cheat'  && c2.type === 'cheat')  return true;  // 5+5 special exception
  if (c1.type === 'colead' && c2.type === 'colead') return true;  // 4+4
  if (c1.type === 'cram'   && c2.type === 'cram')   return c1.value + c2.value === 8;  // 6+2=8
  if (c1.type === 'effort' && c2.type === 'effort') return c1.value + c2.value === 8;
  return false;
}

// ── Count cards of a given type across project pile + all party piles ──
function _countTypeInAllPiles(type, state) {
  let n = 0;
  for (const c of state.projectPile) if (c.type === type) n++;
  for (const p of Object.values(state.players)) {
    for (const c of p.partyPile) if (c.type === type) n++;
  }
  return n;
}

// ── Compute project pile total with optional skill effects ─
// Handles X2 Copy card chaining + wrap-around.
// effects may include:
//   cramCount  — Cram cards in THIS pile only (+1 per other Cram in same pile)
//   cheatCount — Cheat cards in THIS pile only (-2 per other Cheat in same pile)
export function computePileTotal(pile, effects = {}) {
  // Build a working copy with skill + special-card modifications applied
  let working = pile.map(card => {
    let v = card.value;
    if (card.type === 'effort') {
      // Skill effects apply only to regular effort cards
      if (effects.evenodds && v % 2 !== 0) v = 4;
      if (effects.coffee && v >= 1 && v <= 3) v = v * 2;
    } else if (card.type === 'cram') {
      // Cram: +1 for each OTHER Cram card across both piles
      const otherCrams = Math.max(0, (effects.cramCount || 0) - 1);
      v = v + otherCrams;
    } else if (card.type === 'cheat') {
      // Cheat: -2 for each OTHER Cheat card across both piles (can go negative)
      const otherCheats = Math.max(0, (effects.cheatCount || 0) - 1);
      v = v - 2 * otherCheats;
    }
    // colead type: base value 4, no modifier here (transfer happens on project pass)
    // copy type: unchanged
    return { ...card, value: v };
  });

  // Plagiarize: first copy card becomes X3
  let plagiarizeUsed = false;

  let pendingMult = 1;
  const efforts = [];

  for (let i = 0; i < working.length; i++) {
    const card = working[i];
    if (card.type === 'copy') {
      let mult = 2;
      if (effects.plagiarize && !plagiarizeUsed) { mult = 3; plagiarizeUsed = true; }
      pendingMult *= mult;
    } else {
      let val = card.value;
      // All-Nighter: final face-down card is doubled (it's always the last card)
      if (effects.allnighter && i === working.length - 1) pendingMult *= 2;
      efforts.push({ value: val, mult: pendingMult });
      pendingMult = 1;
    }
  }

  if (efforts.length === 0) return 0;

  // Trailing copy multiplier wraps to first effort card
  if (pendingMult > 1) efforts[0].mult *= pendingMult;

  return efforts.reduce((s, e) => s + e.value * e.mult, 0);
}

// ── Skill bonus calculation (non-pile effects) ────────────
function calcSkillBonus(state, skill, wasFaceDown) {
  const pile = state.projectPile;
  switch (skill.id) {
    case 'diversity': {
      const unique = new Set(pile.filter(c => c.type === 'effort').map(c => c.value));
      return unique.size;
    }
    case 'vibe': {
      const vals = pile.filter(c => c.type === 'effort').map(c => c.value);
      const cnt = {};
      for (const v of vals) cnt[v] = (cnt[v] || 0) + 1;
      return Object.values(cnt).reduce((s, c) => s + Math.floor(c / 2), 0) * 4;
    }
    case 'reputation': {
      const totalEC = Object.values(state.players).reduce((s, p) => s + p.extraCredits, 0);
      return totalEC * 1;
    }
    case 'curve': {
      state.targetBonus  = (state.targetBonus  || 0) - 6;
      state.nextTargetPenalty = (state.nextTargetPenalty || 0) + 6;
      return 0;   // handled via targetBonus
    }
    case 'eureka': return wasFaceDown ? 10 : 5;
    case 'desperation': {
      const leader = state.players[state.projectLeaderId];
      return totalFails(leader) * 2;
    }
    default: return 0;
  }
}

// ── Apply individual fail ─────────────────────────────────
export function applyIndividualFail(state, playerId) {
  const limit  = state.failLimit ?? FAIL_LIMIT;
  const events = [];
  const p = state.players[playerId];
  p.individualFails += 1;
  const total = totalFails(p);
  events.push(evt('INDIVIDUAL_FAIL', { playerId, failCount: total }));
  addLog(state, {
    type: 'fail',
    text: `${p.name} receives an Individual Fail (${total}/${limit}).`,
    playerId,
  });
  checkExpulsion(state, playerId, events);
  return events;
}

// ── Apply group fail to all active players ────────────────
export function applyGroupFail(state) {
  const limit  = state.failLimit ?? FAIL_LIMIT;
  const events = [];
  for (const id of activePlayers(state)) {
    const p = state.players[id];
    p.groupFails += 1;
    const total = totalFails(p);
    events.push(evt('GROUP_FAIL', { playerId: id, failCount: total }));
    addLog(state, {
      type: 'fail',
      text: `${p.name} receives a Group Fail (${total}/${limit}).`,
      playerId: id,
    });
    checkExpulsion(state, id, events);
  }
  return events;
}

// ── Check if a player should be expelled ─────────────────
// Expulsion is DEFERRED to semester break so the player can finish
// the current round (avoid freezing blame / snitch chains mid-round).
function checkExpulsion(state, playerId, events) {
  const limit = state.failLimit ?? FAIL_LIMIT;
  const p = state.players[playerId];
  if (totalFails(p) >= limit && !p.isExpelled && !p.pendingExpulsion) {
    p.pendingExpulsion = true;
    // Log immediately so the game log is accurate, but don't set isExpelled
    // yet — that happens at the start of semesterBreak.
    addLog(state, {
      type: 'expel',
      text: `${p.name} has reached ${limit} fails — EXPELLED at end of round.`,
      playerId,
    });
  }
}

// ── Award extra credit ────────────────────────────────────
function awardExtraCredit(state, playerId) {
  const events = [];
  const p = state.players[playerId];
  if (p && !p.isExpelled) {
    p.extraCredits += 1;
    events.push(evt('EXTRA_CREDIT', { playerId }));
    addLog(state, {
      type: 'system',
      text: `${p.name} earns an Extra Credit!`,
      playerId,
    });
  }
  return events;
}

// ── Leader awards extra credit to a chosen player ────────
// Called after project passes via Let It Ride
export function awardLeaderExtraCredit(state, { leaderId, recipientId }) {
  if (state.pendingSkillStep !== 'extra-credit-pick')
    throw new Error('No extra credit pick pending');
  if (state.projectLeaderId !== leaderId)
    throw new Error('Only the project leader can award extra credit');
  const active = activePlayers(state);
  if (!active.includes(recipientId) || recipientId === leaderId)
    throw new Error('Invalid extra credit recipient');

  state.pendingSkillStep = null;
  state.activePlayerId   = null;

  const events = awardExtraCredit(state, recipientId);
  addLog(state, {
    type: 'system',
    text: `${state.players[leaderId].name} awards Extra Credit to ${state.players[recipientId].name}.`,
  });

  // Simple mode: track who received the leader's EC gift, then run Group Eval
  if (state.gameMode === 'simple') {
    state.simpleECGiftPlayerId = recipientId;
    _startGroupEval(state, events);
  } else {
    state.phase = 'BREAK';
  }

  return events;
}

// ── Mark top party pile card for end-of-semester discard ──
export function markTopPartyForDiscard(state, playerId) {
  const pile = state.players[playerId].partyPile;
  if (pile.length === 0) return;
  const idx = pile.length - 1;
  const marks = state.players[playerId].markedForDiscard;
  if (!marks.includes(idx)) marks.push(idx);
}

// ── Apply all marked discards (called at end of semester) ─
export function applyEndOfSemesterDiscards(state, events) {
  for (const id of state.playerOrder) {
    const p = state.players[id];
    if (p.markedForDiscard.length === 0) continue;
    const idxs = [...p.markedForDiscard].sort((a, b) => b - a);
    const discarded = [];
    for (const idx of idxs) {
      if (idx < p.partyPile.length) discarded.push(...p.partyPile.splice(idx, 1));
    }
    p.markedForDiscard = [];
    if (discarded.length > 0) {
      // Co-Lead fail Option B: +1 individual fail for each discarded Co-Lead card
      if (state.coLeadFailMode === 'discard') {
        for (const c of discarded) {
          if (c.type === 'colead') {
            addLog(state, {
              type: 'fail',
              text: `${p.name} takes a Co-Lead penalty fail (card discarded).`,
              playerId: id,
            });
            events.push(...applyIndividualFail(state, id));
          }
        }
      }
      events.push(evt('PARTY_CARDS_DISCARDED', { playerId: id, cards: discarded }));
    }
  }
}

// ── Eligible blame voters ─────────────────────────────────
function getVoters(state) {
  return activePlayers(state).filter(
    id => id !== state.projectLeaderId && id !== state.blameAccusedId
  );
}

// ── Start Group Evaluation (Simple mode) ──────────────────
// Only ever runs after a PASS without Extra Credit — a project FAIL
// now goes through the separate "Who's to Blame?" flow below.
function _startGroupEval(state, events) {
  const active = activePlayers(state);
  state.roundSlackerVotes  = {};
  state.evalRoundCounts    = {};
  state.evalAccusedId      = null;
  state.evalTiedPlayers    = [];
  state.evalVotersRemaining = [...active];
  state.simpleVoteContext  = 'pass';
  state.phase              = 'GROUP_EVAL';
  state.activePlayerId     = active[0] ?? null;
  events.push(evt('GROUP_EVAL_START', {
    voters: active,
    projectLeaderId: state.projectLeaderId,
  }));
  addLog(state, {
    type: 'system',
    text: `Group Evaluation — each player places a Slacker card on who they think slacked off.`,
  });
}

// ── Start "Who's to Blame?" fail vote (Simple mode) ───────
// Runs whenever a project FAILS in simple mode, after every active
// player has already taken a simultaneous Group Fail. This vote decides
// who's on the hook for ONE additional Fail, which can be passed along
// an optional Snitch chain.
function _startFailBlameVote(state, events) {
  const active = activePlayers(state);

  state.roundFailVotes          = {};
  state.failRoundCounts         = {};
  state.failTiedPlayers         = [];
  state.failVoteVotersRemaining = [...active];
  state.simpleVoteContext       = 'fail';
  state.phase                   = 'SIMPLE_BLAME_VOTE';
  state.activePlayerId          = active[0] ?? null;
  events.push(evt('FAIL_BLAME_VOTE_START', {
    voters: active,
    projectLeaderId: state.projectLeaderId,
  }));
  addLog(state, {
    type: 'fail',
    text: `The project FAILED — everyone takes a Fail. Now vote on who's to blame for one extra Fail.`,
  });
}

// ── Resolve project pass/fail after final card is flipped ─
function resolveOutcome(state, events) {
  const effects   = { ...(state.skillEffects || {}) };
  const skillId   = state.chosenSkill?.id;

  // Both Cram and Cheat: count only within the project pile
  effects.cramCount  = state.projectPile.filter(c => c.type === 'cram').length;
  effects.cheatCount = state.projectPile.filter(c => c.type === 'cheat').length;

  // Apply Complain to the Dean: remove 2 lowest effort cards first
  if (skillId === 'complain') {
    const effort = state.projectPile
      .filter(c => c.type === 'effort')
      .sort((a, b) => a.value - b.value);
    const toRemove = effort.slice(0, 2);
    state.projectPile = state.projectPile.filter(c => !toRemove.find(r => r.id === c.id));
    events.push(evt('CARDS_REMOVED', { removed: toRemove }));
  }

  const baseTotal = computePileTotal(state.projectPile, effects);
  const skillBonus = state.chosenSkill
    ? calcSkillBonus(state, state.chosenSkill, state.chosenSkillWasFaceDown)
    : 0;
  const complainBonus = skillId === 'complain' ? 8 : 0;
  const total = baseTotal + skillBonus + complainBonus;

  const effectiveTarget = state.projectTarget + (state.targetBonus || 0);
  const totalSkillBonus = skillBonus + complainBonus;
  events.push(evt('EFFORT_UPDATED', {
    total,
    target:     effectiveTarget,
    skillBonus: totalSkillBonus,
    skillName:  state.chosenSkill?.name ?? null,
  }));

  const passed = total >= effectiveTarget;

  if (passed) {
    events.push(evt('PROJECT_PASSED', { total, target: effectiveTarget }));
    addLog(state, { type: 'pass', text: `Project PASSED — ${total} / ${effectiveTarget}!` });

    // Co-Lead transfer: Co-Lead cards in project pile move to the player's own party pile
    for (const card of [...state.projectPile]) {
      if (card.type === 'colead') {
        const p = state.players[card.playerId];
        if (p) {
          state.projectPile = state.projectPile.filter(c => c.id !== card.id);
          const transferred = { ...card, revealed: true };
          p.partyPile.push(transferred);
          events.push(evt('COLEAD_TRANSFERRED', { playerId: card.playerId, card: transferred }));
          addLog(state, {
            type: 'system',
            text: `${p.name}'s Co-Lead card transfers to their Party Pile!`,
            playerId: card.playerId,
          });
        }
      }
    }

    // Extra Credits — only when Let It Ride is used (no skill)
    if (!state.chosenSkill) {
      state.extraCreditAwardedThisRound = true;
      const leaderId = state.projectLeaderId;
      events.push(...awardExtraCredit(state, leaderId));
      const active = activePlayers(state);
      if (active.length > 1) {
        state.pendingSkillStep = 'extra-credit-pick';
        state.activePlayerId   = leaderId;
        events.push(evt('EXTRA_CREDIT_PICK_NEEDED', { leaderId, options: active.filter(id => id !== leaderId) }));
        // awardLeaderExtraCredit will handle phase transition after pick
        return;
      }
    }

    if (state.gameMode === 'simple') {
      // Group Eval always runs after a pass — if EC was awarded (single-player
      // path: no pick needed), simpleECGiftPlayerId stays null but eval still runs.
      _startGroupEval(state, events);
    } else {
      state.phase = 'BREAK';
    }
  } else {
    const shortfall = effectiveTarget - total;
    events.push(evt('PROJECT_FAILED', { total, target: effectiveTarget, shortfall }));
    addLog(state, {
      type: 'fail',
      text: `Project FAILED — ${total} / ${effectiveTarget} (${shortfall} short).`,
    });
    state.projectsFailed += 1;

    // Group Fail — ALL active players, simultaneously, in every mode
    events.push(...applyGroupFail(state));

    if (state.gameMode === 'simple') {
      // Simple mode: on top of the simultaneous Group Fail, a
      // "Who's to Blame?" vote + optional Snitch chain decides who also
      // takes ONE extra Fail.
      _startFailBlameVote(state, events);
    } else {
      // Co-Lead fail Option A: +1 individual fail for each player whose Co-Lead
      // is still in the project pile when the exam fails
      if (state.coLeadFailMode === 'exam_fail') {
        for (const card of state.projectPile) {
          if (card.type === 'colead' && card.playerId) {
            const p = state.players[card.playerId];
            if (p) {
              addLog(state, {
                type: 'fail',
                text: `${p.name} takes a Co-Lead penalty fail (exam failed).`,
                playerId: card.playerId,
              });
              events.push(...applyIndividualFail(state, card.playerId));
            }
          }
        }
      }

      // Move to BLAME
      state.phase          = 'BLAME';
      state.activePlayerId = state.projectLeaderId;
    }
  }
}

// ==========================================================
//  EXPORTED ENGINE FUNCTIONS
// ==========================================================

// ── playPair ──────────────────────────────────────────────
// Submit a pair of cards (must sum to 8 or be copy+copy).
export function playPair(state, { playerId, projectCardId, partyCardId }) {
  if (state.phase !== 'PLAYING')
    throw new Error(`playPair called in phase ${state.phase}`);
  if (state.activePlayerId !== playerId)
    throw new Error(`Not ${playerId}'s turn`);

  const player = state.players[playerId];
  if (player.playedPair) throw new Error(`${playerId} already played this semester`);

  const projIdx = player.hand.findIndex(c => c.id === projectCardId);
  const partIdx = player.hand.findIndex(c => c.id === partyCardId);
  if (projIdx === -1) throw new Error(`Card ${projectCardId} not in hand`);
  if (partIdx === -1) throw new Error(`Card ${partyCardId} not in hand`);
  if (projIdx === partIdx) throw new Error('Must choose two different cards');

  const projCard = player.hand[projIdx];
  const partCard = player.hand[partIdx];

  if (!isValidPair(projCard, partCard))
    throw new Error(`Invalid pair: ${projCard.value}+${partCard.value} (must sum to 8)`);

  // Remove both from hand
  player.hand = player.hand.filter(c => c.id !== projectCardId && c.id !== partyCardId);

  // Project pile (face-down, tagged with playerId so skills can find it)
  const pCard = { ...projCard, revealed: false, playerId };
  state.projectPile.push(pCard);
  player.semesterProjectCard = { id: projCard.id, value: projCard.value, type: projCard.type };

  // Party pile (face-down)
  const qCard = { ...partCard, revealed: false };
  player.partyPile.push(qCard);
  player.semesterPartyCard = { id: partCard.id, value: partCard.value, type: partCard.type };

  player.playedPair = true;

  const events = [
    evt('CARD_PLAYED_PROJECT', { playerId, card: pCard }),
    evt('CARD_PLAYED_PARTY',   { playerId, card: qCard }),
  ];
  addLog(state, { type: 'play', text: `${player.name} played a pair.`, playerId });

  // Check if everyone has played
  const active = activePlayers(state);
  const allPlayed = active.every(id => state.players[id].playedPair);

  if (allPlayed) {
    // Shuffle project pile so no one knows card order
    state.projectPile = shuffle(state.projectPile);
    state.phase = 'REVEAL';
    state.activePlayerId = null;
    events.push(evt('REVEAL_START', { projectPile: state.projectPile }));
    addLog(state, { type: 'system', text: 'All pairs played — beginning reveal.' });
  } else {
    const next = nextPlayer(state, playerId);
    state.activePlayerId = next;
    events.push(evt('TURN_ADVANCED', { playerId: next }));
  }

  return events;
}

// ── Partial reveal total (no wrap-around for trailing copy) ──
// Used during intermediate reveals. Accepts optional effects for
// Cram/Cheat bonuses so the running counter is accurate.
function _partialRevealTotal(pile, effects = {}) {
  let pendingMult = 1;
  let total       = 0;
  for (const card of pile) {
    if (!card.revealed) continue;
    if (card.type === 'copy') {
      pendingMult *= 2;
    } else {
      let val = card.value;
      if (card.type === 'cram') {
        const otherCrams = Math.max(0, (effects.cramCount || 0) - 1);
        val = val + otherCrams;
      } else if (card.type === 'cheat') {
        const otherCheats = Math.max(0, (effects.cheatCount || 0) - 1);
        val = val - 2 * otherCheats;
      }
      total      += val * pendingMult;
      pendingMult = 1;
    }
  }
  // Don't wrap trailing pendingMult — that multiplier is still pending
  return total;
}

// ── revealPhase ───────────────────────────────────────────
// Reveals all project pile cards EXCEPT the last one.
// Stops at DEADLINE when exactly 1 unrevealed card remains.
export function revealPhase(state) {
  if (state.phase !== 'REVEAL')
    throw new Error(`revealPhase called in phase ${state.phase}`);

  const events   = [];
  const unrevealed = state.projectPile.filter(c => !c.revealed);

  // If only 1 card total in pile (single player game edge case), go to DEADLINE immediately
  if (unrevealed.length <= 1) {
    _goDeadline(state, events);
    return events;
  }

  // Reveal all except the last unrevealed card
  const toReveal = unrevealed.slice(0, -1);
  // Both Cram and Cheat: count only within the project pile
  const revEffects = {
    cramCount:  state.projectPile.filter(c => c.type === 'cram').length,
    cheatCount: state.projectPile.filter(c => c.type === 'cheat').length,
  };
  for (const card of toReveal) {
    card.revealed = true;
    // Use forward-only partial total so copy cards don't prematurely
    // wrap to multiply an earlier card — the ×2 visually applies to
    // the next card revealed, not the first card in the pile.
    const partialTotal = _partialRevealTotal(state.projectPile, revEffects);
    events.push(evt('CARD_REVEALED', { card, runningTotal: partialTotal, target: state.projectTarget }));
    events.push(evt('EFFORT_UPDATED', { total: partialTotal, target: state.projectTarget }));
  }

  _goDeadline(state, events);
  return events;
}

function _goDeadline(state, events) {
  state.phase = 'DEADLINE';
  state.activePlayerId = state.projectLeaderId;
  events.push(evt('DEADLINE_START', {
    faceUpSkill:  state.faceUpSkill,
    faceDownSkill: state.faceDownSkill,
  }));
  addLog(state, {
    type: 'system',
    text: `Day of the Deadline — 1 card remains. ${state.players[state.projectLeaderId].name} must decide.`,
  });
}

// ── letItRide ─────────────────────────────────────────────
// Flip the final card without using a leadership skill.
export function letItRide(state) {
  if (state.phase !== 'DEADLINE')
    throw new Error(`letItRide called in phase ${state.phase}`);

  const events = [];
  state.chosenSkill    = null;
  state.skillEffects   = {};

  const lastCard = state.projectPile.find(c => !c.revealed);
  if (lastCard) {
    lastCard.revealed = true;
    events.push(evt('CARD_REVEALED', { card: lastCard, final: true }));
  }

  addLog(state, {
    type: 'system',
    text: `${state.players[state.projectLeaderId].name} chose Let It Ride.`,
  });

  resolveOutcome(state, events);
  return events;
}

// ── useLeadershipSkill ────────────────────────────────────
// skillChoice: 'faceup' | 'facedown'
export function useLeadershipSkill(state, skillChoice) {
  if (state.phase !== 'DEADLINE')
    throw new Error(`useLeadershipSkill called in phase ${state.phase}`);

  const skill = skillChoice === 'faceup' ? state.faceUpSkill : state.faceDownSkill;
  if (!skill) throw new Error(`No ${skillChoice} skill available`);

  const wasFaceDown = skillChoice === 'facedown';
  state.chosenSkill          = skill;
  state.chosenSkillWasFaceDown = wasFaceDown;

  addLog(state, {
    type: 'system',
    text: `${state.players[state.projectLeaderId].name} uses "${skill.name}"!`,
  });

  const events = [evt('SKILL_USED', { skill, wasFaceDown })];

  // Realign Priorities requires picking a target — defer resolution
  if (skill.id === 'realign') {
    state.pendingSkillStep = 'realign-pick-target';
    events.push(evt('SKILL_NEEDS_TARGET', { skill }));
    return events;
  }

  // Build skill effects for computePileTotal
  state.skillEffects = {};
  if (skill.id === 'allnighter') state.skillEffects.allnighter = true;
  if (skill.id === 'coffee')     state.skillEffects.coffee     = true;
  if (skill.id === 'plagiarize') state.skillEffects.plagiarize = true;
  if (skill.id === 'evenodds')   state.skillEffects.evenodds   = true;

  // Flip the final card
  const lastCard = state.projectPile.find(c => !c.revealed);
  if (lastCard) {
    lastCard.revealed = true;
    events.push(evt('CARD_REVEALED', { card: lastCard, final: true }));
  }

  // Discard used skill + draw replacement
  _rotateSkill(state, skillChoice);

  resolveOutcome(state, events);
  return events;
}

// ── completeRealignSkill ──────────────────────────────────
// Called after Realign Priorities target is chosen.
export function completeRealignSkill(state, targetId) {
  if (state.pendingSkillStep !== 'realign-pick-target')
    throw new Error('Not waiting for realign target');

  const events = [];
  state.pendingSkillStep = null;
  state.realignTargetId  = targetId;

  const target   = state.players[targetId];
  const projCard = state.projectPile.find(c => c.playerId === targetId);
  const partyTop = target.partyPile[target.partyPile.length - 1];

  if (projCard && partyTop) {
    partyTop.revealed = true;
    const pIdx = state.projectPile.indexOf(projCard);
    const qIdx = target.partyPile.length - 1;
    const oldProj = state.projectPile[pIdx];
    state.projectPile[pIdx] = { ...partyTop, revealed: true, playerId: targetId };
    target.partyPile[qIdx]  = { ...oldProj, revealed: false };
    events.push(evt('REALIGN_SWAP', { targetId, oldProjCard: oldProj, newProjCard: state.projectPile[pIdx] }));
    addLog(state, { type: 'system', text: `Realign Priorities: ${target.name}'s cards swapped!` });
  }

  state.skillEffects = {};

  const lastCard = state.projectPile.find(c => !c.revealed);
  if (lastCard) {
    lastCard.revealed = true;
    events.push(evt('CARD_REVEALED', { card: lastCard, final: true }));
  }

  _rotateSkill(state, state.chosenSkillWasFaceDown ? 'facedown' : 'faceup');

  resolveOutcome(state, events);
  return events;
}

function _rotateSkill(state, which) {
  if (which === 'faceup') {
    state.faceUpSkill  = state.leadershipDeck.shift() ?? null;
  } else {
    state.faceDownSkill = state.leadershipDeck.shift() ?? null;
  }
}

// ── accusePlayer ──────────────────────────────────────────
// Project Leader accuses a player; blame voting begins.
export function accusePlayer(state, { accuserId, accusedId }) {
  if (state.phase !== 'BLAME')
    throw new Error(`accusePlayer called in phase ${state.phase}`);
  if (accuserId !== state.projectLeaderId)
    throw new Error('Only the Project Leader can accuse');
  if (accusedId === accuserId)
    throw new Error('Cannot accuse yourself');
  const accusedPlayer = state.players[accusedId];
  if (accusedPlayer?.isExpelled || accusedPlayer?.pendingExpulsion)
    throw new Error('Cannot accuse an expelled player');

  const events = [];
  state.blameAccusedId = accusedId;

  const leader = state.players[accuserId];
  const accused = state.players[accusedId];
  events.push(evt('BLAME_CAST', { accuserId, accusedId }));
  addLog(state, {
    type: 'blame',
    text: `${leader.name} accuses ${accused.name}!`,
    playerId: accuserId,
  });

  // Track for AI vindictiveness
  accused.blamedByHistory.push(accuserId);

  const voters = getVoters(state);
  state.blameVotes           = {};
  state.blameVotersRemaining = [...voters];

  if (voters.length === 0) {
    // No eligible voters — accused automatically takes Individual Fail
    return _tallyVotes(state, events);
  }

  state.phase = 'BLAME_VOTE';
  state.activePlayerId = voters[0];
  events.push(evt('VOTING_START', { voters, accusedId, accuserId }));
  return events;
}

// ── castVote ──────────────────────────────────────────────
// A voter casts their vote ('accused' or 'leader')
export function castVote(state, { voterId, voteFor }) {
  if (state.phase !== 'BLAME_VOTE')
    throw new Error(`castVote called in phase ${state.phase}`);
  if (!state.blameVotersRemaining.includes(voterId))
    throw new Error(`${voterId} is not a remaining voter`);

  const events = [];
  state.blameVotes[voterId] = voteFor;
  state.blameVotersRemaining = state.blameVotersRemaining.filter(id => id !== voterId);

  events.push(evt('VOTE_CAST', { voterId, voteFor }));
  addLog(state, {
    type: 'system',
    text: `${state.players[voterId].name} voted.`,
    playerId: voterId,
  });

  if (state.blameVotersRemaining.length === 0) {
    return _tallyVotes(state, events);
  }

  const next = state.blameVotersRemaining[0];
  state.activePlayerId = next;
  events.push(evt('NEXT_VOTER', { voterId: next }));
  return events;
}

// ── _tallyVotes (internal) ────────────────────────────────
function _tallyVotes(state, existingEvents) {
  const events = existingEvents || [];
  const accusedId = state.blameAccusedId;
  const leaderId  = state.projectLeaderId;

  const voteCounts = {};
  for (const vote of Object.values(state.blameVotes)) {
    voteCounts[vote] = (voteCounts[vote] || 0) + 1;
  }
  const aV = voteCounts[accusedId] || 0;
  const lV = voteCounts[leaderId]  || 0;

  events.push(evt('VOTES_TALLIED', { voteCounts, accusedId, leaderId }));

  let failTarget = null;

  if (aV > lV) {
    failTarget = accusedId;
  } else if (lV > aV) {
    failTarget = leaderId;
  } else {
    // TIE — investigation: compare top party pile cards
    const aTop = state.players[accusedId].partyPile[state.players[accusedId].partyPile.length - 1];
    const lTop = state.players[leaderId ].partyPile[state.players[leaderId ].partyPile.length - 1];
    // copy=9 for tie-break; cram/cheat/colead use base value; no card=-1
    const aVal = aTop ? (aTop.type === 'copy' ? 9 : aTop.value) : -1;
    const lVal = lTop ? (lTop.type === 'copy' ? 9 : lTop.value) : -1;

    if (aTop) aTop.revealed = true;
    if (lTop) lTop.revealed = true;

    events.push(evt('TIE_INVESTIGATION', { accusedId, leaderId, accusedCard: aTop, leaderCard: lTop }));
    addLog(state, { type: 'blame', text: 'Tied vote! Investigation: comparing top Party Pile cards.' });

    if (aVal > lVal) {
      failTarget = accusedId;
    } else if (lVal > aVal) {
      failTarget = leaderId;
    } else {
      // Both equal — both fail, no snitch
      events.push(...applyIndividualFail(state, accusedId));
      events.push(...applyIndividualFail(state, leaderId));
      markTopPartyForDiscard(state, accusedId);
      markTopPartyForDiscard(state, leaderId);
      state.snitchCurrentId = null;
      state.phase = 'BREAK';
      applyEndOfSemesterDiscards(state, events);
      return events;
    }
  }

  if (failTarget) {
    addLog(state, {
      type: 'blame',
      text: `${state.players[failTarget].name} receives an Individual Fail from the vote!`,
      playerId: failTarget,
    });
    events.push(...applyIndividualFail(state, failTarget));
    markTopPartyForDiscard(state, failTarget);
  }

  // Blamed player (failTarget or accused if no clear loser) starts snitch chain
  state.snitchCurrentId = failTarget || accusedId;
  state.snitchChain     = [];
  state.phase           = 'SNITCH';
  state.activePlayerId  = state.snitchCurrentId;
  events.push(evt('SNITCH_PHASE_START', { snitcherId: state.snitchCurrentId }));

  return events;
}

// ── skipBlame ─────────────────────────────────────────────
export function skipBlame(state) {
  if (state.phase !== 'BLAME')
    throw new Error(`skipBlame called in phase ${state.phase}`);

  state.phase = 'BREAK';
  addLog(state, {
    type: 'system',
    text: `${state.players[state.projectLeaderId].name} chose not to blame anyone.`,
  });
  return [evt('BLAME_SKIPPED', { leaderId: state.projectLeaderId })];
}

// ── snitchTarget ──────────────────────────────────────────
// The current snitch player names a target.
export function snitchTarget(state, { snitcherId, targetId }) {
  if (state.phase !== 'SNITCH')
    throw new Error(`snitchTarget called in phase ${state.phase}`);
  if (state.snitchCurrentId !== snitcherId)
    throw new Error(`Not ${snitcherId}'s snitch turn`);
  if (targetId === snitcherId)
    throw new Error('Cannot snitch on yourself');
  if ((state.snitchedThisTurn || []).includes(targetId))
    throw new Error(`${state.players[targetId]?.name ?? targetId} has already been snitched this turn`);

  const events   = [];
  const snitcher = state.players[snitcherId];
  const target   = state.players[targetId];

  const targetTop = target.partyPile[target.partyPile.length - 1];
  if (!targetTop) {
    addLog(state, { type: 'snitch', text: `${target.name} has no party pile card — snitch fails!` });
    return _snitchFails(state, events, snitcherId);
  }

  targetTop.revealed = true;

  const snitcherTop = snitcher.partyPile[snitcher.partyPile.length - 1];
  // Copy cards count as 9 (beats every effort 0-8); cram/cheat/colead use base value
  const sVal = snitcherTop ? (snitcherTop.type === 'copy' ? 9 : snitcherTop.value) : 0;
  const tVal = targetTop.type === 'copy' ? 9 : targetTop.value;

  events.push(evt('SNITCH_REVEALED', {
    snitcherId, targetId, targetCard: targetTop, snitcherValue: sVal,
  }));
  addLog(state, {
    type: 'snitch',
    text: `${snitcher.name} snitches on ${target.name} — target reveals ${tVal}.`,
    playerId: snitcherId,
  });

  state.snitchChain.push({ snitcherId, targetId, tVal, sVal });

  // Mark target as snitched — they cannot be targeted again this semester
  if (!state.snitchedThisTurn) state.snitchedThisTurn = [];
  if (!state.snitchedThisTurn.includes(targetId)) state.snitchedThisTurn.push(targetId);

  if (tVal >= sVal) {
    // Snitch succeeds — target card >= snitcher's card
    addLog(state, {
      type: 'snitch',
      text: `Snitch SUCCEEDS — ${target.name}(${tVal}) >= ${snitcher.name}(${sVal}).`,
    });
    events.push(evt('SNITCH_SUCCESS', { snitcherId, targetId }));
    events.push(...applyIndividualFail(state, targetId));
    markTopPartyForDiscard(state, targetId);

    state.snitchCurrentId = targetId;
    state.activePlayerId  = targetId;
    events.push(evt('SNITCH_TURN', { snitcherId: targetId }));
  } else {
    // Snitch fails — snitcher loses cards
    addLog(state, {
      type: 'snitch',
      text: `Snitch FAILS — ${target.name}(${tVal}) < ${snitcher.name}(${sVal}).`,
    });
    events.push(evt('SNITCH_FAIL', { snitcherId, targetId }));
    return _snitchFails(state, events, snitcherId);
  }

  return events;
}

function _snitchFails(state, events, snitcherId) {
  const p    = state.players[snitcherId];
  const pile = p.partyPile;

  if (pile.length >= 2) {
    pile[pile.length - 1].revealed = true;
    pile[pile.length - 2].revealed = true;
    const d = [pile.pop(), pile.pop()];
    // Co-Lead Option B: fail for each co-lead card lost in snitch
    if (state.coLeadFailMode === 'discard') {
      for (const c of d) {
        if (c.type === 'colead') {
          addLog(state, {
            type: 'fail',
            text: `${p.name} takes a Co-Lead penalty fail (card lost in snitch).`,
            playerId: snitcherId,
          });
          events.push(...applyIndividualFail(state, snitcherId));
        }
      }
    }
    events.push(evt('SNITCH_DISCARD', { playerId: snitcherId, discarded: d }));
    addLog(state, {
      type: 'snitch',
      text: `${p.name} loses their top 2 Party Pile cards.`,
      playerId: snitcherId,
    });
  } else if (pile.length === 1) {
    const d = [pile.pop()];
    if (state.coLeadFailMode === 'discard' && d[0].type === 'colead') {
      addLog(state, {
        type: 'fail',
        text: `${p.name} takes a Co-Lead penalty fail (card lost in snitch).`,
        playerId: snitcherId,
      });
      events.push(...applyIndividualFail(state, snitcherId));
    }
    events.push(evt('SNITCH_DISCARD', { playerId: snitcherId, discarded: d }));
    events.push(...applyIndividualFail(state, snitcherId));
    addLog(state, {
      type: 'snitch',
      text: `${p.name} loses their only Party Pile card and takes an extra fail.`,
      playerId: snitcherId,
    });
  } else {
    events.push(...applyIndividualFail(state, snitcherId));
    addLog(state, {
      type: 'snitch',
      text: `${p.name} has no cards to lose — takes an extra fail.`,
      playerId: snitcherId,
    });
  }

  state.snitchCurrentId = null;
  state.phase = 'BREAK';
  applyEndOfSemesterDiscards(state, events);
  return events;
}

// ── snitchPass ────────────────────────────────────────────
export function snitchPass(state) {
  if (state.phase !== 'SNITCH')
    throw new Error(`snitchPass called in phase ${state.phase}`);

  const events = [];
  addLog(state, {
    type: 'snitch',
    text: `${state.players[state.snitchCurrentId].name} passes — snitch chain ends.`,
  });
  events.push(evt('SNITCH_PASSED', { snitcherId: state.snitchCurrentId }));
  state.snitchCurrentId = null;
  state.phase = 'BREAK';
  applyEndOfSemesterDiscards(state, events);
  return events;
}

// ── semesterBreak ─────────────────────────────────────────
// Called when the human clicks "Next Semester" in BREAK phase.
export function semesterBreak(state) {
  if (state.phase !== 'BREAK')
    throw new Error(`semesterBreak called in phase ${state.phase}`);

  const events = [];

  // ── Finalise any deferred expulsions from this round ────
  for (const id of state.playerOrder) {
    const p = state.players[id];
    if (p.pendingExpulsion && !p.isExpelled) {
      p.isExpelled      = true;
      p.pendingExpulsion = false;
      events.push(evt('PLAYER_EXPELLED', { playerId: id }));
      addLog(state, {
        type: 'expel',
        text: `${p.name} has been EXPELLED (${state.failLimit ?? FAIL_LIMIT} fails).`,
        playerId: id,
      });
    }
  }

  // ── Elimination checks — done BEFORE leader rotation ───────
  // Computing activeNow here (after finalising expulsions) prevents
  // projectLeaderId from pointing at an expelled player, which was
  // the cause of the reported game freeze.
  const activeNow = activePlayers(state);

  // All players expelled this round → special winner via highest
  // project card played in the final round (copy counts as zero).
  if (activeNow.length === 0) {
    return _endGameAllExpelled(state, events);
  }

  // One survivor → outright winner.
  // Two survivors from a game that started with 3+ → half-hand rule.
  if (activeNow.length === 1 ||
      (state.playerOrder.length > 2 && activeNow.length === 2)) {
    return _endGameEliminationLimit(state, events, activeNow);
  }

  if (state.semester >= state.totalSemesters) {
    const reason = 'semesters-complete';
    state.gameEndReason = reason;
    _computeFinalScores(state);
    state.phase = 'GAMEOVER';
    events.push(evt('GAME_OVER', { players: state.players, gameEndReason: reason }));
    const label = state.gameMode === 'simple' ? 'All 6 rounds complete' : 'All 8 semesters complete';
    addLog(state, { type: 'system', text: `${label} — game over!` });
    return events;
  }

  const prevSem = state.semester;
  state.semester    += 1;
  state.semesterName = state.projectCards?.[state.semester - 1]?.subject
    ?? (state.gameMode === 'simple'
      ? `Round ${state.semester}`
      : `Semester ${state.semester}`);
  state.projectPile   = [];
  state.blameAccusedId       = null;
  state.blameVotes           = {};
  state.blameVotersRemaining = [];
  state.snitchCurrentId      = null;
  state.snitchChain          = [];
  state.snitchedThisTurn     = [];
  state.chosenSkill          = null;
  state.skillEffects         = {};
  state.pendingSkillStep     = null;
  // Reset Group Eval state for new round
  state.roundSlackerVotes          = {};
  state.evalRoundCounts            = {};
  state.evalAccusedId              = null;
  state.evalVotersRemaining        = [];
  state.evalTiedPlayers            = [];
  state.extraCreditAwardedThisRound = false;
  // Reset "Who's to Blame?" fail-vote + Snitch state for new round
  state.roundFailVotes             = {};
  state.failRoundCounts            = {};
  state.failVoteVotersRemaining    = [];
  state.failTiedPlayers            = [];
  state.simpleSnitchCurrentId      = null;
  state.simpleSnitchedThisRound    = [];
  state.simpleAppealBlamedId       = null;
  state.simpleSelfRevealPlayerId   = null;
  state.simpleVoteContext          = null;
  state.simpleECGiftPlayerId       = null;

  // Apply carry-over target penalty (Curve the Grade)
  state.targetBonus      = state.nextTargetPenalty || 0;
  state.nextTargetPenalty = 0;

  // Rotate Project Leader
  const active = activePlayers(state);
  const li = active.indexOf(state.projectLeaderId);
  state.projectLeaderId = active[(li + 1) % active.length];
  state.activePlayerId  = state.projectLeaderId;

  // Update target
  state.projectTarget = state.gameMode === 'simple'
    ? getSimpleTarget(state.projectCards?.[state.semester - 1], active.length, state.difficulty || 1)
    : getTarget(state.semester, active.length, state.difficulty || 1);

  // Reset per-semester player state
  for (const id of state.playerOrder) {
    const p = state.players[id];
    p.playedPair          = false;
    p.semesterProjectCard = null;
    p.semesterPartyCard   = null;
  }

  const isBreak = state.gameMode !== 'simple' && BREAK_SEMESTERS.has(prevSem);

  if (isBreak) {
    // Refresh face-up leadership skill
    if (state.faceUpSkill) state.leadershipDeck.push(state.faceUpSkill);
    state.faceUpSkill = state.leadershipDeck.shift() ?? null;

    state.phase             = 'BREAK_DRAW';
    state.breakDrawOrder    = [...active];
    state.breakDrawCurrent  = state.breakDrawOrder[0];
    state.activePlayerId    = state.breakDrawOrder[0];

    events.push(evt('SEMESTER_BREAK_START', {
      semester: state.semester, leaderId: state.projectLeaderId,
      drawOrder: state.breakDrawOrder,
    }));
    addLog(state, {
      type: 'system',
      text: `Semester Break after Semester ${prevSem}. Each player draws one new pair.`,
    });
  } else {
    state.phase = 'PLAYING';
    events.push(evt('SEMESTER_START', {
      semester:      state.semester,
      projectTarget: state.projectTarget,
      leaderId:      state.projectLeaderId,
      projectCard:   state.projectCards?.[state.semester - 1] ?? null,
    }));
    addLog(state, {
      type: 'system',
      text: `Semester ${state.semester} — ${state.semesterName}. Target: ${state.projectTarget}. Leader: ${state.players[state.projectLeaderId].name}.`,
    });
  }

  return events;
}

// ── _endGameAllExpelled ───────────────────────────────────
// Called when ALL players have been expelled simultaneously.
// No one survives to score normally, so the winner is determined
// by who played the highest value card to the project pile in the
// final round (copy cards count as 0 for this comparison).
function _endGameAllExpelled(state, events) {
  addLog(state, { type: 'system', text: 'All players have been expelled — the game ends!' });

  // copy → 0; any type with numeric value → that value; no card → -1
  const cardVal = c =>
    !c ? -1 : (c.type === 'copy' || c.value === 'copy' ? 0 : Number(c.value ?? -1));

  let maxVal = -1;
  for (const id of state.playerOrder) {
    const v = cardVal(state.players[id].semesterProjectCard);
    if (v > maxVal) maxVal = v;
  }

  const winners = maxVal >= 0
    ? state.playerOrder.filter(id => cardVal(state.players[id].semesterProjectCard) === maxVal)
    : [];

  state.gameEndReason  = 'all-expelled';
  state.specialWinners = winners;

  if (winners.length > 0) {
    const names = winners.map(id => state.players[id].name).join(' & ');
    addLog(state, {
      type: 'system',
      text: `Special Win — ${names} played the highest project card (${maxVal} effort) and is declared winner${winners.length > 1 ? 's' : ''}!`,
    });
  } else {
    addLog(state, { type: 'system', text: 'No project cards found — no winner can be determined.' });
  }

  state.phase = 'GAMEOVER';
  _computeFinalScores(state);
  events.push(evt('GAME_OVER', {
    players:        state.players,
    gameEndReason:  'all-expelled',
    specialWinners: winners,
  }));
  return events;
}

// ── _endGameEliminationLimit ──────────────────────────────
// "Two Players Remaining" rule: if eliminations have reduced the
// game (which started with more than two players) down to two —
// or fewer — active players, the game ends immediately.
//   • Each remaining player takes half of the cards left in their
//     hand (rounded up) and places them face-up on top of their
//     Party Pile.
//   • Any Group Projects that would still have been attempted are
//     considered to have been PASSED for Academic Goal scoring.
function _endGameEliminationLimit(state, events, active) {
  addLog(state, {
    type: 'system',
    text: `Eliminations have reduced the game to ${active.length} active player${active.length === 1 ? '' : 's'} — the game ends immediately!`,
  });

  // Each remaining player moves half their hand (rounded up) onto
  // the top of their Party Pile, face-up, before final scoring.
  for (const id of active) {
    const p = state.players[id];
    const halfCount = Math.ceil(p.hand.length / 2);
    if (halfCount > 0) {
      const taken = p.hand.splice(0, halfCount);
      for (const c of taken) p.partyPile.push({ ...c, revealed: true });
      addLog(state, {
        type: 'system',
        text: `${p.name} places ${taken.length} card${taken.length === 1 ? '' : 's'} from their hand onto the top of their Party Pile.`,
        playerId: id,
      });
    }
  }

  // Any Group Projects that never got played are counted as PASSED
  // for the purposes of the final Academic Goal (pass/fail) verdict.
  const remaining = Math.max(0, state.totalSemesters - state.semester);
  for (let i = 0; i < remaining; i++) {
    addLog(state, {
      type: 'pass',
      text: `${SEMESTER_NAMES[state.semester + i] ?? `Semester ${state.semester + 1 + i}`} is considered PASSED — the game ended early due to eliminations.`,
    });
  }

  state.gameEndReason = 'elimination-limit';
  state.phase = 'GAMEOVER';
  _computeFinalScores(state);
  events.push(evt('GAME_OVER', { players: state.players, gameEndReason: 'elimination-limit' }));
  addLog(state, { type: 'system', text: 'Game over — eliminations have ended the game early. Final scores calculated.' });

  return events;
}

// ── drawPair ──────────────────────────────────────────────
// Called during BREAK_DRAW phase for each player's turn.
// key: '0+8' | 'cram' | 'cheat' | 'colead'
export function drawPair(state, { playerId, key }) {
  if (state.phase !== 'BREAK_DRAW')
    throw new Error(`drawPair called in phase ${state.phase}`);
  if (state.breakDrawCurrent !== playerId)
    throw new Error(`Not ${playerId}'s draw turn`);

  const pairDef = POOL_PAIRS.find(p => p.key === key);
  if (!pairDef) throw new Error(`Unknown pair key: ${key}`);

  const { typeA, valueA, typeB, valueB } = pairDef;
  const pool   = state.effortPool;
  const player = state.players[playerId];

  const i1 = pool.findIndex(c => c.type === typeA && c.value === valueA);
  if (i1 === -1) throw new Error(`No ${typeA}:${valueA} in pool`);
  const i2 = pool.findIndex((c, i) => c.type === typeB && c.value === valueB && i !== i1);
  if (i2 === -1) throw new Error(`No second ${typeB}:${valueB} in pool`);

  const hi = Math.max(i1, i2), lo = Math.min(i1, i2);
  const card1 = pool.splice(hi, 1)[0];
  const card2 = pool.splice(lo, 1)[0];

  player.hand.push(card1, card2);
  // drawnPairs kept for record-keeping but no longer blocks re-draws
  player.drawnPairs.push(key);

  const events = [evt('PAIR_DRAWN', { playerId, cards: [card1, card2], key })];
  addLog(state, {
    type: 'system',
    text: `${player.name} draws the [${key}] pair.`,
    playerId,
  });

  const curIdx = state.breakDrawOrder.indexOf(playerId);
  const nxtIdx = curIdx + 1;

  if (nxtIdx >= state.breakDrawOrder.length) {
    // All players drawn — start the new semester
    state.phase             = 'PLAYING';
    state.activePlayerId    = state.projectLeaderId;
    state.breakDrawOrder    = [];
    state.breakDrawCurrent  = null;
    events.push(evt('SEMESTER_START', {
      semester: state.semester, projectTarget: state.projectTarget,
      leaderId: state.projectLeaderId,
    }));
    addLog(state, {
      type: 'system',
      text: `Semester ${state.semester} — ${state.semesterName}. Target: ${state.projectTarget}. Leader: ${state.players[state.projectLeaderId].name}.`,
    });
  } else {
    state.breakDrawCurrent = state.breakDrawOrder[nxtIdx];
    state.activePlayerId   = state.breakDrawCurrent;
    events.push(evt('BREAK_DRAW_NEXT', { playerId: state.breakDrawCurrent }));
  }

  return events;
}

// ── getAvailablePairKeys ──────────────────────────────────
// Returns all pair keys that still have cards available in the pool.
// No restriction on re-drawing the same pair type (removed drawnPairs check).
export function getAvailablePairKeys(state /*, playerId unused */) {
  const pool = state.effortPool;
  return POOL_PAIRS
    .filter(({ typeA, valueA, typeB, valueB }) => {
      const sameCard = typeA === typeB && valueA === valueB;
      const countA = pool.filter(c => c.type === typeA && c.value === valueA).length;
      const countB = pool.filter(c => c.type === typeB && c.value === valueB).length;
      return sameCard ? countA >= 2 : countA >= 1 && countB >= 1;
    })
    .map(({ key }) => key);
}

// ── getValidActions ───────────────────────────────────────
export function getValidActions(state) {
  const actions = new Set();
  const pid     = state.activePlayerId;
  if (!pid) return actions;
  const player = state.players[pid];
  if (!player || player.isExpelled) return actions;

  switch (state.phase) {
    case 'PLAYING':
      if (!player.playedPair && player.hand.length >= 2) actions.add('PLAY_PAIR');
      break;
    case 'REVEAL':
      actions.add('REVEAL');
      break;
    case 'DEADLINE':
      if (pid === state.projectLeaderId) {
        actions.add('LET_IT_RIDE');
        if (state.faceUpSkill)  actions.add('USE_SKILL_FACEUP');
        if (state.faceDownSkill) actions.add('USE_SKILL_FACEDOWN');
        if (state.pendingSkillStep === 'realign-pick-target') actions.add('PICK_REALIGN_TARGET');
      }
      break;
    case 'BLAME':
      if (pid === state.projectLeaderId) {
        const targets = activePlayers(state).filter(id => id !== pid);
        if (targets.length > 0) actions.add('ACCUSE');
        actions.add('SKIP_BLAME');
      }
      break;
    case 'BLAME_VOTE':
      if (state.blameVotersRemaining.includes(pid)) actions.add('CAST_VOTE');
      break;
    case 'SNITCH':
      if (pid === state.snitchCurrentId) {
        const targets = activePlayers(state).filter(id => id !== pid);
        if (targets.length > 0) actions.add('SNITCH_TARGET');
        actions.add('SNITCH_PASS');
      }
      break;
    case 'BREAK':
      actions.add('NEXT_SEMESTER');
      break;
    case 'BREAK_DRAW':
      if (pid === state.breakDrawCurrent) actions.add('DRAW_PAIR');
      break;
    case 'GAMEOVER':
      actions.add('VIEW_SCORES');
      break;
  }

  return actions;
}

// ── Final score calculation ───────────────────────────────
function _computeFinalScores(state) {
  for (const id of state.playerOrder) {
    const p = state.players[id];
    if (p.isExpelled) { p.academicPoints = 0; continue; }

    // Cram and Cheat: count only within this player's own party pile
    const cramCount  = p.partyPile.filter(c => c.type === 'cram').length;
    const cheatCount = p.partyPile.filter(c => c.type === 'cheat').length;
    const effects    = { cramCount, cheatCount };
    const partyScore = computePileTotal(p.partyPile, effects);
    const ecBonus    = p.extraCredits * 3;
    const cleanBonus = (state.gameMode !== 'simple' && p.individualFails === 0) ? p.extraCredits * 2 : 0;
    // Each Slacker card is worth -3 points; each Successful Slack Off is +5
    const slackerPenalty = state.gameMode === 'simple'
      ? (state.slackerTokens?.[id] ?? 0) * 3
      : 0;
    const slackOffBonus = state.gameMode === 'simple'
      ? (state.successfulSlackOff?.[id] ?? 0) * 5
      : 0;
    p.academicPoints = Math.max(0, partyScore) + ecBonus + cleanBonus - slackerPenalty + slackOffBonus;
  }
}
