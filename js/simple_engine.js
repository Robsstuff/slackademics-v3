/* =====================================================
   SLACKADEMICS — Simple Mode Engine
   Group Evaluation phase logic (slacker voting, appeal).

   Phases added by this module:
     GROUP_EVAL           — all players placing slacker votes
     GROUP_EVAL_LEADER_TIE — leader breaks a tie
     GROUP_EVAL_APPEAL    — accused player may appeal

   Events emitted:
     SLACKER_VOTE_CAST    { voterId, targetId }
     EVAL_VOTES_REVEALED  { counts, leaderId }
     EVAL_TIE             { tied, leaderId }
     EVAL_TIE_BROKEN      { chosenId, leaderId }
     EVAL_ACCUSED         { accusedId, partyVal, isHighest, allVals }
     EVAL_CONFIRMED_SLACKER { slackerId, tokens }
     EVAL_APPEAL_OFFERED  { accusedId }
     EVAL_APPEAL_NAMED    { accusedId, targetId }
     EVAL_APPEAL_SUCCESS  { accusedId, targetId, targetPartyVal }
     EVAL_APPEAL_FAIL     { accusedId, targetId, taken }
     SLACKER_CARDS_CAPPED { playerId, cap, discarded }
     EVAL_ROUND_DONE      { slackerTokens }
   ===================================================== */
'use strict';

import { addLog, totalFails }        from './state.js';
import { activePlayers, applyIndividualFail } from './engine.js';

function evt(type, payload = {}) { return { type, ...payload }; }

// ── Party-card value from project card ────────────────────
// Each pair sums to 8 (effort) or is copy+copy.
// When project card is copy, party card is also copy → value 9 (highest).
export function partyCardValue(projectCard) {
  if (!projectCard) return -1;
  if (projectCard.type === 'copy') return 9;
  return 8 - Number(projectCard.value ?? 0);
}

// ── castSlackerVote ───────────────────────────────────────
// A player places their slacker card on a target.
// When the last voter submits, votes are immediately resolved.
export function castSlackerVote(state, voterId, targetId) {
  if (state.phase !== 'GROUP_EVAL')
    throw new Error(`castSlackerVote called in phase ${state.phase}`);
  if (!state.evalVotersRemaining.includes(voterId))
    throw new Error(`${voterId} is not a remaining voter`);
  if (voterId === targetId)
    throw new Error('Cannot vote for yourself');

  const events = [];
  state.roundSlackerVotes[voterId] = targetId;
  state.evalVotersRemaining = state.evalVotersRemaining.filter(id => id !== voterId);

  events.push(evt('SLACKER_VOTE_CAST', { voterId, targetId }));
  addLog(state, {
    type:     'system',
    text:     `${state.players[voterId].name} placed a Slacker card.`,
    playerId: voterId,
  });

  if (state.evalVotersRemaining.length === 0) {
    _resolveAllVotes(state, events);
  }

  return events;
}

// ── leaderBreakTie ────────────────────────────────────────
// Leader moves one slacker card onto a tied player to break the tie.
export function leaderBreakTie(state, chosenId) {
  if (state.phase !== 'GROUP_EVAL_LEADER_TIE')
    throw new Error(`leaderBreakTie called in phase ${state.phase}`);

  const events = [];
  state.evalRoundCounts[chosenId] = (state.evalRoundCounts[chosenId] ?? 0) + 1;
  state.evalTiedPlayers = [];

  const leader = state.players[state.projectLeaderId];
  const chosen = state.players[chosenId];
  events.push(evt('EVAL_TIE_BROKEN', { chosenId, leaderId: state.projectLeaderId }));
  addLog(state, {
    type: 'system',
    text: `${leader.name} moves a Slacker card to ${chosen.name} to break the tie.`,
  });

  state.evalAccusedId = chosenId;
  _checkAccused(state, events);
  return events;
}

// ── doAppeal ─────────────────────────────────────────────
// Accused player names another player to check as the real slacker.
export function doAppeal(state, accusedId, targetId) {
  if (state.phase !== 'GROUP_EVAL_APPEAL')
    throw new Error(`doAppeal called in phase ${state.phase}`);

  const events    = [];
  const accused   = state.players[accusedId];
  const target    = state.players[targetId];
  const accusedPV = partyCardValue(accused.semesterProjectCard);
  const targetPV  = partyCardValue(target.semesterProjectCard);

  events.push(evt('EVAL_APPEAL_NAMED', { accusedId, targetId }));
  addLog(state, {
    type: 'blame',
    text: `${accused.name} appeals, naming ${target.name} as the real Slacker.`,
  });

  if (targetPV > accusedPV) {
    // Appeal succeeds — target is the real slacker
    const total = Object.values(state.evalRoundCounts).reduce((s, n) => s + n, 0);
    for (const id of Object.keys(state.evalRoundCounts)) {
      state.evalRoundCounts[id] = 0;
    }
    state.slackerTokens[targetId] = (state.slackerTokens[targetId] ?? 0) + total;

    events.push(evt('EVAL_APPEAL_SUCCESS', { accusedId, targetId, targetPartyVal: targetPV }));
    addLog(state, {
      type: 'blame',
      text: `${accused.name} appeals successfully! ${target.name} had the highest Party card (${targetPV}) and takes all ${total} Slacker card${total !== 1 ? 's' : ''}.`,
    });

    if (state.evalIsOnFail) {
      // Extra fail transfers to the confirmed slacker
      events.push(...applyIndividualFail(state, targetId));
      addLog(state, {
        type:     'fail',
        text:     `${target.name} also takes the extra fail (project failed + confirmed slacker).`,
        playerId: targetId,
      });
    }
  } else {
    // Appeal fails — named player's entire round pile transfers to the
    // accused. Everyone else's Slacker cards stay exactly where they are.
    const taken = state.evalRoundCounts[targetId] ?? 0;
    state.evalRoundCounts[targetId]  = 0;
    state.evalRoundCounts[accusedId] = (state.evalRoundCounts[accusedId] ?? 0) + taken;

    events.push(evt('EVAL_APPEAL_FAIL', { accusedId, targetId, taken }));
    addLog(state, {
      type: 'blame',
      text: `${accused.name}'s appeal failed — ${target.name}'s Party card (${targetPV}) was not higher. ` +
            `${target.name} gives ${accused.name} ${taken > 0 ? `their ${taken} Slacker card${taken !== 1 ? 's' : ''}` : 'their Slacker cards (none held)'}.`,
    });
  }

  _finalizeEval(state, events);
  return events;
}

// ── skipAppeal ────────────────────────────────────────────
// Accused declines to appeal (or no eligible appeal target exists).
export function skipAppeal(state, accusedId) {
  if (state.phase !== 'GROUP_EVAL_APPEAL')
    throw new Error(`skipAppeal called in phase ${state.phase}`);

  const events = [];
  addLog(state, {
    type:     'system',
    text:     `${state.players[accusedId].name} does not appeal.`,
    playerId: accusedId,
  });
  _finalizeEval(state, events);
  return events;
}

// ── Internal helpers ──────────────────────────────────────

function _resolveAllVotes(state, events) {
  // Tally vote counts
  const counts = {};
  for (const targetId of Object.values(state.roundSlackerVotes)) {
    counts[targetId] = (counts[targetId] ?? 0) + 1;
  }
  state.evalRoundCounts = counts;

  const maxCount = counts && Object.keys(counts).length > 0
    ? Math.max(...Object.values(counts))
    : 0;
  const tied = Object.keys(counts).filter(id => counts[id] === maxCount);

  events.push(evt('EVAL_VOTES_REVEALED', {
    counts,
    leaderId: state.projectLeaderId,
    votes:    state.roundSlackerVotes,
  }));

  if (tied.length > 1) {
    // Tie — project leader must break it
    state.evalTiedPlayers = tied;
    state.phase = 'GROUP_EVAL_LEADER_TIE';
    state.activePlayerId = state.projectLeaderId;
    events.push(evt('EVAL_TIE', { tied, leaderId: state.projectLeaderId }));
    addLog(state, {
      type: 'system',
      text: `Tied vote! ${state.players[state.projectLeaderId].name} must move one Slacker card to break the tie.`,
    });
  } else if (tied.length === 1) {
    state.evalAccusedId = tied[0];
    _checkAccused(state, events);
  } else {
    // No votes cast (0-player edge case) — skip eval
    _finalizeEval(state, events);
  }
}

function _checkAccused(state, events) {
  const accusedId  = state.evalAccusedId;
  const accused    = state.players[accusedId];
  const accusedPV  = partyCardValue(accused.semesterProjectCard);

  const active = activePlayers(state);
  const allVals = active.map(id => ({
    id,
    partyVal: partyCardValue(state.players[id].semesterProjectCard),
  }));
  const maxPV = Math.max(...allVals.map(x => x.partyVal));
  const isHighest = accusedPV >= maxPV;

  events.push(evt('EVAL_ACCUSED', {
    accusedId,
    partyVal:  accusedPV,
    isHighest,
    allVals,
  }));

  if (isHighest) {
    _resolveAsSlacker(state, events, accusedId);
  } else {
    // Accused gets one appeal — check if there's someone eligible to appeal to
    const eligible = active.filter(id =>
      id !== accusedId && (state.evalRoundCounts[id] ?? 0) > 0
    );
    state.phase          = 'GROUP_EVAL_APPEAL';
    state.activePlayerId = accusedId;
    events.push(evt('EVAL_APPEAL_OFFERED', { accusedId, eligible }));
    addLog(state, {
      type:     'blame',
      text:     `${accused.name} did not play the highest Party card (${accusedPV}). They may appeal.`,
      playerId: accusedId,
    });
  }
}

function _resolveAsSlacker(state, events, slackerId) {
  // Accused IS the confirmed slacker — takes all other players' round cards
  let transferred = 0;
  for (const id of Object.keys(state.evalRoundCounts)) {
    if (id !== slackerId) {
      transferred += state.evalRoundCounts[id] ?? 0;
      state.evalRoundCounts[id] = 0;
    }
  }
  state.evalRoundCounts[slackerId] = (state.evalRoundCounts[slackerId] ?? 0) + transferred;

  const slacker = state.players[slackerId];
  events.push(evt('EVAL_CONFIRMED_SLACKER', {
    slackerId,
    transferred,
    partyVal: partyCardValue(slacker.semesterProjectCard),
  }));
  addLog(state, {
    type:     'blame',
    text:     `${slacker.name} played the highest Party card and is the Slacker! They take ${transferred} extra Slacker card${transferred !== 1 ? 's' : ''} from other players.`,
    playerId: slackerId,
  });

  if (state.evalIsOnFail) {
    events.push(...applyIndividualFail(state, slackerId));
    addLog(state, {
      type:     'fail',
      text:     `${slacker.name} also takes an extra fail (project failed + confirmed slacker).`,
      playerId: slackerId,
    });
  }

  _finalizeEval(state, events);
}

// ── Top party pile card's numeric value (Copy counts as 9) ─
function _partyTopCardValue(card) {
  if (!card) return 0;
  if (card.type === 'copy') return 9;
  return Number(card.value ?? 0);
}

function _finalizeEval(state, events) {
  // Cap: a player can never bank more Slacker cards this round than the
  // value of their own current top Party Pile card — excess is discarded
  // from the round pile BEFORE it moves to the bank. Once a card is in
  // the bank it's locked and is never touched again by a later round.
  for (const id of activePlayers(state)) {
    const player = state.players[id];
    const cap    = _partyTopCardValue(player.partyPile[player.partyPile.length - 1]);
    const held   = state.evalRoundCounts[id] ?? 0;
    if (held > cap) {
      state.evalRoundCounts[id] = cap;
      events.push(evt('SLACKER_CARDS_CAPPED', { playerId: id, cap, discarded: held - cap }));
      addLog(state, {
        type:     'system',
        text:     `${player.name}'s top Party card (${cap}) caps their round Slacker cards — ${held - cap} discarded.`,
        playerId: id,
      });
    }
  }

  // Move this round's (now-capped) Slacker cards into each player's
  // permanent Slacker Bank, next to their Party Pile.
  for (const [id, count] of Object.entries(state.evalRoundCounts)) {
    if (count > 0) {
      state.slackerTokens[id] = (state.slackerTokens[id] ?? 0) + count;
    }
  }
  state.evalRoundCounts = {};
  state.evalAccusedId   = null;

  events.push(evt('EVAL_ROUND_DONE', { slackerTokens: { ...state.slackerTokens } }));
  addLog(state, {
    type: 'system',
    text: 'Group Evaluation complete — Slacker cards placed with player piles.',
  });

  state.phase = 'BREAK';
}
