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
  addLog, getTarget, totalFails, pairKey,
  FAIL_LIMIT, TOTAL_SEMESTERS, BREAK_SEMESTERS,
  SEMESTER_NAMES, POOL_PAIRS, makeCard,
} from './state.js';
import { shuffle } from './utils.js';

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
  if (c1.type === 'copy' && c2.type === 'copy') return true;
  if (c1.type === 'effort' && c2.type === 'effort') return c1.value + c2.value === 8;
  return false;
}

// ── Compute project pile total with optional skill effects ─
// Handles X2 Copy card chaining + wrap-around.
export function computePileTotal(pile, effects = {}) {
  // Build a working copy with skill modifications applied
  let working = pile.map(card => {
    if (card.type !== 'effort') return card;
    let v = card.value;
    if (effects.evenodds && v % 2 !== 0) v = 4;
    if (effects.coffee && v >= 1 && v <= 3) v = v * 2;
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
      return totalEC * 2;
    }
    case 'curve': {
      state.targetBonus  = (state.targetBonus  || 0) - 6;
      state.nextTargetPenalty = (state.nextTargetPenalty || 0) + 6;
      return 0;   // handled via targetBonus
    }
    case 'eureka': return wasFaceDown ? 10 : 5;
    case 'desperation': return (state.projectsFailed || 0) * 5;
    default: return 0;
  }
}

// ── Apply individual fail ─────────────────────────────────
function applyIndividualFail(state, playerId) {
  const events = [];
  const p = state.players[playerId];
  p.individualFails += 1;
  const total = totalFails(p);
  events.push(evt('INDIVIDUAL_FAIL', { playerId, failCount: total }));
  addLog(state, {
    type: 'fail',
    text: `${p.name} receives an Individual Fail (${total}/${FAIL_LIMIT}).`,
    playerId,
  });
  checkExpulsion(state, playerId, events);
  return events;
}

// ── Apply group fail to all active players ────────────────
function applyGroupFail(state) {
  const events = [];
  for (const id of activePlayers(state)) {
    const p = state.players[id];
    p.groupFails += 1;
    const total = totalFails(p);
    events.push(evt('GROUP_FAIL', { playerId: id, failCount: total }));
    addLog(state, {
      type: 'fail',
      text: `${p.name} receives a Group Fail (${total}/${FAIL_LIMIT}).`,
      playerId: id,
    });
    checkExpulsion(state, id, events);
  }
  return events;
}

// ── Check if a player should be expelled ─────────────────
function checkExpulsion(state, playerId, events) {
  const p = state.players[playerId];
  if (totalFails(p) >= FAIL_LIMIT && !p.isExpelled) {
    p.isExpelled = true;
    events.push(evt('PLAYER_EXPELLED', { playerId }));
    addLog(state, {
      type: 'expel',
      text: `${p.name} has been EXPELLED (${FAIL_LIMIT} fails).`,
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

// ── Mark top party pile card for end-of-semester discard ──
function markTopPartyForDiscard(state, playerId) {
  const pile = state.players[playerId].partyPile;
  if (pile.length === 0) return;
  const idx = pile.length - 1;
  const marks = state.players[playerId].markedForDiscard;
  if (!marks.includes(idx)) marks.push(idx);
}

// ── Apply all marked discards (called at end of semester) ─
function applyEndOfSemesterDiscards(state, events) {
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

// ── Resolve project pass/fail after final card is flipped ─
function resolveOutcome(state, events) {
  const effects   = state.skillEffects || {};
  const skillId   = state.chosenSkill?.id;

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

    // Extra Credits — only when Let It Ride is used (no skill)
    if (!state.chosenSkill) {
      const leaderId = state.projectLeaderId;
      events.push(...awardExtraCredit(state, leaderId));
      // Leader nominates the next active player
      const active = activePlayers(state);
      if (active.length > 1) {
        const li = active.indexOf(leaderId);
        const nominee = active[(li + 1) % active.length];
        events.push(...awardExtraCredit(state, nominee));
      }
    }

    state.phase = 'BREAK';
  } else {
    const shortfall = effectiveTarget - total;
    events.push(evt('PROJECT_FAILED', { total, target: effectiveTarget, shortfall }));
    addLog(state, {
      type: 'fail',
      text: `Project FAILED — ${total} / ${effectiveTarget} (${shortfall} short).`,
    });
    state.projectsFailed += 1;

    // Group Fail — ALL active players
    events.push(...applyGroupFail(state));

    // Move to BLAME
    state.phase          = 'BLAME';
    state.activePlayerId = state.projectLeaderId;
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
  for (const card of toReveal) {
    card.revealed = true;
    const partialTotal = computePileTotal(state.projectPile.filter(c => c.revealed));
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
  if (state.players[accusedId]?.isExpelled)
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
    const aVal = aTop ? (aTop.type === 'effort' ? aTop.value : 0) : -1;
    const lVal = lTop ? (lTop.type === 'effort' ? lTop.value : 0) : -1;

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
  const sVal = snitcherTop ? (snitcherTop.type === 'effort' ? snitcherTop.value : 0) : 0;
  const tVal = targetTop.type === 'effort' ? targetTop.value : 0;

  events.push(evt('SNITCH_REVEALED', {
    snitcherId, targetId, targetCard: targetTop, snitcherValue: sVal,
  }));
  addLog(state, {
    type: 'snitch',
    text: `${snitcher.name} snitches on ${target.name} — target reveals ${tVal}.`,
    playerId: snitcherId,
  });

  state.snitchChain.push({ snitcherId, targetId, tVal, sVal });

  if (tVal > sVal) {
    // Snitch succeeds — target takes fail, may continue chain
    addLog(state, {
      type: 'snitch',
      text: `Snitch SUCCEEDS — ${target.name}(${tVal}) > ${snitcher.name}(${sVal}).`,
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
      text: `Snitch FAILS — ${target.name}(${tVal}) <= ${snitcher.name}(${sVal}).`,
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
    events.push(evt('SNITCH_DISCARD', { playerId: snitcherId, discarded: d }));
    addLog(state, {
      type: 'snitch',
      text: `${p.name} loses their top 2 Party Pile cards.`,
      playerId: snitcherId,
    });
  } else if (pile.length === 1) {
    const d = [pile.pop()];
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

  if (state.semester >= state.totalSemesters) {
    _computeFinalScores(state);
    state.phase = 'GAMEOVER';
    events.push(evt('GAME_OVER', { players: state.players }));
    addLog(state, { type: 'system', text: 'All 8 semesters complete — game over!' });
    return events;
  }

  const prevSem = state.semester;
  state.semester     += 1;
  state.semesterName  = SEMESTER_NAMES[state.semester - 1];
  state.projectPile   = [];
  state.blameAccusedId       = null;
  state.blameVotes           = {};
  state.blameVotersRemaining = [];
  state.snitchCurrentId      = null;
  state.snitchChain          = [];
  state.chosenSkill          = null;
  state.skillEffects         = {};
  state.pendingSkillStep     = null;

  // Apply carry-over target penalty (Curve the Grade)
  state.targetBonus      = state.nextTargetPenalty || 0;
  state.nextTargetPenalty = 0;

  // Rotate Project Leader
  const active = activePlayers(state);
  const li = active.indexOf(state.projectLeaderId);
  state.projectLeaderId = active[(li + 1) % active.length];
  state.activePlayerId  = state.projectLeaderId;

  // Update target
  state.projectTarget = getTarget(state.semester, active.length);

  // Reset per-semester player state
  for (const id of state.playerOrder) {
    const p = state.players[id];
    p.playedPair          = false;
    p.semesterProjectCard = null;
    p.semesterPartyCard   = null;
  }

  const isBreak = BREAK_SEMESTERS.has(prevSem);

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
      semester: state.semester, projectTarget: state.projectTarget,
      leaderId: state.projectLeaderId,
    }));
    addLog(state, {
      type: 'system',
      text: `Semester ${state.semester} — ${state.semesterName}. Target: ${state.projectTarget}. Leader: ${state.players[state.projectLeaderId].name}.`,
    });
  }

  return events;
}

// ── drawPair ──────────────────────────────────────────────
// Called during BREAK_DRAW phase for each player's turn.
// key: string like '0+8', '3+5', 'copy+copy'
export function drawPair(state, { playerId, key }) {
  if (state.phase !== 'BREAK_DRAW')
    throw new Error(`drawPair called in phase ${state.phase}`);
  if (state.breakDrawCurrent !== playerId)
    throw new Error(`Not ${playerId}'s draw turn`);

  const player = state.players[playerId];
  if (player.drawnPairs.includes(key))
    throw new Error(`${playerId} already drew pair ${key}`);

  // Parse key
  let val1, val2;
  if (key === 'copy+copy') { val1 = 'copy'; val2 = 'copy'; }
  else { [val1, val2] = key.split('+').map(Number); }

  // Find cards in pool
  const pool = state.effortPool;
  const i1 = pool.findIndex(c => c.value === val1);
  if (i1 === -1) throw new Error(`No ${val1} in pool`);
  const i2 = pool.findIndex((c, i) => c.value === val2 && i !== i1);
  if (i2 === -1) throw new Error(`No second ${val2} in pool`);

  const hi = Math.max(i1, i2), lo = Math.min(i1, i2);
  const card1 = pool.splice(hi, 1)[0];
  const card2 = pool.splice(lo, 1)[0];

  player.hand.push(card1, card2);
  player.drawnPairs.push(key);

  const events = [evt('PAIR_DRAWN', { playerId, cards: [card1, card2], key })];
  addLog(state, {
    type: 'system',
    text: `${player.name} draws the [${val1}+${val2}] pair.`,
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
export function getAvailablePairKeys(state, playerId) {
  const player = state.players[playerId];
  const pool   = state.effortPool;

  return POOL_PAIRS
    .map(([a, b]) => ({ key: pairKey(a, b), a, b }))
    .filter(({ key, a, b }) => {
      if (player.drawnPairs.includes(key)) return false;
      const count = v => pool.filter(c => c.value === v).length;
      if (a === b) return count(a) >= 2;
      return count(a) >= 1 && count(b) >= 1;
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

    const partyScore = computePileTotal(p.partyPile);
    const ecBonus    = p.extraCredits * 3;
    const cleanBonus = p.individualFails === 0 ? p.extraCredits * 2 : 0;
    p.academicPoints = partyScore + ecBonus + cleanBonus;
  }
}
