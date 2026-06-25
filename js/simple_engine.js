/* =====================================================
   SLACKADEMICS — Simple Mode Engine
   Two independent post-round flows:

     Group Evaluation  — runs after a PASS without Extra Credit.
       Players vote on who slacked off. Ties are broken by the
       Project Leader moving one vote from one tied player to
       another. Whoever ends up with the most votes IS the Slacker
       — they bank exactly ONE Slacker card (worth -3 points) and
       every other Slacker vote (including any of their own beyond
       the first) is discarded. No reveal/compare step, no appeal.

     Who's to Blame?   — runs after a project FAIL.
       Every active player loses their top Party card at the end
       of the round, no matter what happens below. Players vote on
       who's to blame (ties broken the same way as above); whoever
       gets the most votes is on the hook for a Fail, but can try to
       Snitch their way out of it by naming another player. If the
       named player's top Party card is HIGHER than the current
       holder's, the Snitch succeeds — liability (and the obligation
       to Snitch) transfers to the named player, and the chain keeps
       climbing. Either way, whoever just attempted a Snitch banks a
       Slacker card (-3 points) for the attempt. The chain ends —
       and that link keeps the Fail (on top of their Slacker card) —
       either when a Snitch attempt fails (named player's card is
       equal or lower), or when the current holder has nobody left
       to name. Exactly one Fail is always handed out per round.

   Phases added by this module:
     GROUP_EVAL             — all players placing slacker votes
     GROUP_EVAL_LEADER_TIE  — leader breaks a slacker-vote tie
     SIMPLE_BLAME_VOTE      — all players voting on who's to blame
     SIMPLE_BLAME_LEADER_TIE— leader breaks a blame-vote tie
     SIMPLE_SNITCH          — the current holder names a target

   Events emitted:
     SLACKER_VOTE_CAST      { voterId, targetId }
     EVAL_VOTES_REVEALED    { counts, leaderId, votes }
     EVAL_TIE               { tied, leaderId }
     EVAL_TIE_BROKEN        { fromId, toId, leaderId }
     EVAL_CONFIRMED_SLACKER { slackerId, discarded }
     EVAL_ROUND_DONE        { slackerTokens }

     FAIL_BLAME_VOTE_CAST     { voterId, targetId }
     FAIL_BLAME_VOTES_REVEALED{ counts, leaderId, votes }
     FAIL_BLAME_TIE            { tied, leaderId }
     FAIL_BLAME_TIE_BROKEN     { fromId, toId, leaderId }
     FAIL_BLAMED               { blamedId }
     SIMPLE_SNITCH_TURN        { snitcherId }
     SIMPLE_SNITCH_REVEALED    { snitcherId, targetId, snitcherCard, targetCard, sVal, tVal }
     SIMPLE_SNITCH_SUCCESS     { snitcherId, targetId }
     SIMPLE_SNITCH_FAILURE     { snitcherId, targetId }
     SIMPLE_SNITCH_STOPPED     { playerId }
     FAIL_BLAME_ROUND_DONE     {}
   ===================================================== */
'use strict';

import { addLog }        from './state.js';
import {
  activePlayers, applyIndividualFail,
  markTopPartyForDiscard, applyEndOfSemesterDiscards,
} from './engine.js';

function evt(type, payload = {}) { return { type, ...payload }; }

// ── Party-card value from project card ────────────────────
// Each pair sums to 8 (effort) or is copy+copy.
// When project card is copy, party card is also copy → value 9 (highest).
// Kept for any external callers; internal logic below reads the actual
// Party Pile top card instead (see _topPartyValue).
export function partyCardValue(projectCard) {
  if (!projectCard) return -1;
  if (projectCard.type === 'copy') return 9;
  return 8 - Number(projectCard.value ?? 0);
}

// ── Top Party Pile card's numeric value (Copy counts as 9) ─
function _topPartyValue(player) {
  const card = player.partyPile[player.partyPile.length - 1];
  if (!card) return -1;
  return card.type === 'copy' ? 9 : Number(card.value ?? 0);
}

// =====================================================
//  GROUP EVALUATION — Slacker vote (after a PASS)
// =====================================================

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
// Leader moves one slacker card from one tied player to another to
// break the tie. The recipient becomes the sole Slacker.
export function leaderBreakTie(state, fromId, toId) {
  if (state.phase !== 'GROUP_EVAL_LEADER_TIE')
    throw new Error(`leaderBreakTie called in phase ${state.phase}`);

  const events = [];
  state.evalRoundCounts[fromId] = Math.max(0, (state.evalRoundCounts[fromId] ?? 0) - 1);
  state.evalRoundCounts[toId]   = (state.evalRoundCounts[toId] ?? 0) + 1;
  state.evalTiedPlayers = [];

  const leader = state.players[state.projectLeaderId];
  const from   = state.players[fromId];
  const to     = state.players[toId];
  events.push(evt('EVAL_TIE_BROKEN', { fromId, toId, leaderId: state.projectLeaderId }));
  addLog(state, {
    type: 'system',
    text: `${leader.name} moves a Slacker card from ${from?.name ?? fromId} to ${to.name} to break the tie.`,
  });

  _resolveAsSlacker(state, events, toId);
  return events;
}

// ── Internal helpers ──────────────────────────────────────

function _resolveAllVotes(state, events) {
  const counts = {};
  for (const targetId of Object.values(state.roundSlackerVotes)) {
    counts[targetId] = (counts[targetId] ?? 0) + 1;
  }
  state.evalRoundCounts = counts;

  const maxCount = Object.keys(counts).length > 0
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
    _resolveAsSlacker(state, events, tied[0]);
  } else {
    // No votes cast (0-player edge case) — skip eval
    _finalizeEval(state, events);
  }
}

// Whoever gets the most votes IS the Slacker — no reveal/compare step.
// They bank exactly one Slacker card; every other Slacker vote (including
// any of their own beyond the first) is discarded outright.
function _resolveAsSlacker(state, events, slackerId) {
  for (const id of Object.keys(state.evalRoundCounts)) {
    if (id !== slackerId) state.evalRoundCounts[id] = 0;
  }
  const held      = state.evalRoundCounts[slackerId] ?? 0;
  const discarded = Math.max(0, held - 1);
  state.evalRoundCounts[slackerId] = Math.min(held, 1);

  const slacker = state.players[slackerId];
  events.push(evt('EVAL_CONFIRMED_SLACKER', { slackerId, discarded }));
  addLog(state, {
    type:     'blame',
    text:     `${slacker.name} IS the Slacker! They bank one Slacker card (-3 points)` +
              (discarded > 0 ? ` — ${discarded} other Slacker card${discarded !== 1 ? 's' : ''} discarded.` : '.'),
    playerId: slackerId,
  });

  _finalizeEval(state, events);
}

function _finalizeEval(state, events) {
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

// =====================================================
//  "WHO'S TO BLAME?" — Fail vote + one-shot Snitch (after a FAIL)
// =====================================================

// ── castFailBlameVote ─────────────────────────────────────
export function castFailBlameVote(state, voterId, targetId) {
  if (state.phase !== 'SIMPLE_BLAME_VOTE')
    throw new Error(`castFailBlameVote called in phase ${state.phase}`);
  if (!state.failVoteVotersRemaining.includes(voterId))
    throw new Error(`${voterId} is not a remaining voter`);
  if (voterId === targetId)
    throw new Error('Cannot vote for yourself');

  const events = [];
  state.roundFailVotes[voterId] = targetId;
  state.failVoteVotersRemaining = state.failVoteVotersRemaining.filter(id => id !== voterId);

  events.push(evt('FAIL_BLAME_VOTE_CAST', { voterId, targetId }));
  addLog(state, {
    type:     'system',
    text:     `${state.players[voterId].name} casts a blame vote.`,
    playerId: voterId,
  });

  if (state.failVoteVotersRemaining.length === 0) {
    _resolveFailVotes(state, events);
  }

  return events;
}

// ── leaderBreakFailTie ────────────────────────────────────
export function leaderBreakFailTie(state, fromId, toId) {
  if (state.phase !== 'SIMPLE_BLAME_LEADER_TIE')
    throw new Error(`leaderBreakFailTie called in phase ${state.phase}`);

  const events = [];
  state.failRoundCounts[fromId] = Math.max(0, (state.failRoundCounts[fromId] ?? 0) - 1);
  state.failRoundCounts[toId]   = (state.failRoundCounts[toId] ?? 0) + 1;
  state.failTiedPlayers = [];

  const leader = state.players[state.projectLeaderId];
  const from   = state.players[fromId];
  const to     = state.players[toId];
  events.push(evt('FAIL_BLAME_TIE_BROKEN', { fromId, toId, leaderId: state.projectLeaderId }));
  addLog(state, {
    type: 'system',
    text: `${leader.name} moves a Fail card from ${from?.name ?? fromId} to ${to.name} to break the tie.`,
  });

  _startSnitchPhase(state, events, toId);
  return events;
}

function _resolveFailVotes(state, events) {
  const counts = {};
  for (const targetId of Object.values(state.roundFailVotes)) {
    counts[targetId] = (counts[targetId] ?? 0) + 1;
  }
  state.failRoundCounts = counts;

  const maxCount = Object.keys(counts).length > 0
    ? Math.max(...Object.values(counts))
    : 0;
  const tied = Object.keys(counts).filter(id => counts[id] === maxCount);

  events.push(evt('FAIL_BLAME_VOTES_REVEALED', {
    counts,
    leaderId: state.projectLeaderId,
    votes:    state.roundFailVotes,
  }));

  if (tied.length > 1) {
    state.failTiedPlayers = tied;
    state.phase = 'SIMPLE_BLAME_LEADER_TIE';
    state.activePlayerId = state.projectLeaderId;
    events.push(evt('FAIL_BLAME_TIE', { tied, leaderId: state.projectLeaderId }));
    addLog(state, {
      type: 'system',
      text: `Tied vote! ${state.players[state.projectLeaderId].name} must move one Fail card to break the tie.`,
    });
  } else if (tied.length === 1) {
    _startSnitchPhase(state, events, tied[0]);
  } else {
    // No votes cast (0-player edge case) — skip straight to BREAK
    state.phase = 'BREAK';
    applyEndOfSemesterDiscards(state, events);
    events.push(evt('FAIL_BLAME_ROUND_DONE', {}));
  }
}

// The blamed player isn't given the Fail yet — they can try to Snitch
// their way out of it first.
function _startSnitchPhase(state, events, blamedId) {
  const blamed = state.players[blamedId];
  events.push(evt('FAIL_BLAMED', { blamedId }));
  addLog(state, {
    type:     'fail',
    text:     `${blamed.name} is blamed for the failed project — must Snitch to try to avoid the Fail!`,
    playerId: blamedId,
  });

  state.simpleSnitchedThisRound = [blamedId];
  state.phase = 'SIMPLE_SNITCH';
  _setSnitchCurrent(state, events, blamedId);
}

// ── simpleSnitchTarget ─────────────────────────────────────
// The current holder names another player. If the named player's top
// Party card is HIGHER than the current holder's, the Snitch succeeds:
// liability transfers to the named player, who must now Snitch in turn
// (the chain keeps climbing). Otherwise (equal, lower, or the current
// holder already holds the single highest card) the Snitch fails: they
// keep the Fail. Either way, whoever just attempted the Snitch banks a
// Slacker card (-3 points). Every active player already lost their top
// Party card when the fail vote started.
export function simpleSnitchTarget(state, snitcherId, targetId) {
  if (state.phase !== 'SIMPLE_SNITCH')
    throw new Error(`simpleSnitchTarget called in phase ${state.phase}`);
  if (state.simpleSnitchCurrentId !== snitcherId)
    throw new Error(`Not ${snitcherId}'s snitch turn`);
  if (targetId === snitcherId)
    throw new Error('Cannot snitch on yourself');
  if ((state.simpleSnitchedThisRound || []).includes(targetId))
    throw new Error(`${state.players[targetId]?.name ?? targetId} has already been named this round`);

  const events   = [];
  const snitcher = state.players[snitcherId];
  const target   = state.players[targetId];

  const snitcherTop = snitcher.partyPile[snitcher.partyPile.length - 1];
  const targetTop   = target.partyPile[target.partyPile.length - 1];
  if (snitcherTop) snitcherTop.revealed = true;
  if (targetTop)   targetTop.revealed   = true;

  const sVal = _topPartyValue(snitcher);
  const tVal = _topPartyValue(target);

  state.simpleSnitchedThisRound.push(targetId);

  events.push(evt('SIMPLE_SNITCH_REVEALED', {
    snitcherId, targetId, snitcherCard: snitcherTop, targetCard: targetTop, sVal, tVal,
  }));

  state.slackerTokens[snitcherId] = (state.slackerTokens[snitcherId] ?? 0) + 1;

  if (tVal > sVal) {
    events.push(evt('SIMPLE_SNITCH_SUCCESS', { snitcherId, targetId }));
    addLog(state, {
      type:     'snitch',
      text:     `${snitcher.name} snitches on ${target.name} — ${target.name}(${tVal}) > ${snitcher.name}(${sVal}). ` +
                `Snitch succeeds! ${snitcher.name} banks a Slacker card (-3 points) — ${target.name} must now Snitch to avoid the Fail!`,
      playerId: snitcherId,
    });
    _setSnitchCurrent(state, events, targetId);
  } else {
    events.push(...applyIndividualFail(state, snitcherId));
    events.push(evt('SIMPLE_SNITCH_FAILURE', { snitcherId, targetId }));
    addLog(state, {
      type:     'snitch',
      text:     `${snitcher.name} snitches on ${target.name} — ${target.name}(${tVal}) <= ${snitcher.name}(${sVal}). ` +
                `Snitch fails! ${snitcher.name} keeps the Fail AND banks a Slacker card (-3 points).`,
      playerId: snitcherId,
    });
    _endSnitchPhase(state, events);
  }

  return events;
}

// Players still eligible to be named by `currentId` in this chain.
function _eligibleSnitchTargets(state, currentId) {
  const already = state.simpleSnitchedThisRound || [];
  return activePlayers(state).filter(id => id !== currentId && !already.includes(id));
}

// Sets who must Snitch next — or, if nobody is left to name, ends the
// chain with that player keeping the Fail (a Fail is always handed out).
function _setSnitchCurrent(state, events, playerId) {
  if (_eligibleSnitchTargets(state, playerId).length === 0) {
    state.slackerTokens[playerId] = (state.slackerTokens[playerId] ?? 0) + 1;
    events.push(...applyIndividualFail(state, playerId));
    events.push(evt('SIMPLE_SNITCH_STOPPED', { playerId }));
    addLog(state, {
      type:     'snitch',
      text:     `${state.players[playerId].name} has no one left to snitch on — keeps the Fail AND banks a Slacker card (-3 points)!`,
      playerId,
    });
    _endSnitchPhase(state, events);
    return;
  }
  state.simpleSnitchCurrentId = playerId;
  state.activePlayerId        = playerId;
  events.push(evt('SIMPLE_SNITCH_TURN', { snitcherId: playerId }));
}

function _endSnitchPhase(state, events) {
  state.simpleSnitchCurrentId   = null;
  state.simpleSnitchedThisRound = [];
  state.phase = 'BREAK';
  applyEndOfSemesterDiscards(state, events);
  events.push(evt('FAIL_BLAME_ROUND_DONE', {}));
  addLog(state, { type: 'system', text: 'Round resolved — everyone discards their top Party card.' });
}
