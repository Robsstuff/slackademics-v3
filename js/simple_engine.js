/* =====================================================
   SLACKADEMICS — Simple Mode Engine
   Two independent post-round flows:

     Group Evaluation  — runs after a PASS without Extra Credit.
       Players vote on who slacked off. The most-voted player
       reveals their top Party card. If it's the highest (or
       equal-highest) of all active players they ARE the Slacker
       and bank their own Slacker votes (capped by their Party
       card value). Otherwise they bank exactly one Slacker card.
       Every other player's Slacker vote is discarded. No appeal.

     Who's to Blame?   — runs after a project FAIL.
       Players vote on who's to blame. The most-voted player takes
       an Individual Fail, marks their top Party card for discard,
       and must Snitch. The Snitch chain climbs from player to
       player as long as each newly-named player's Party card is
       >= the card of whoever named them (each such player also
       takes a Fail + discard mark and must Snitch on). The chain
       stops — and the last linked player banks one bonus Slacker
       card — either when a named player turns out to hold the
       single highest (or equal-highest) Party card in the game,
       or when a named player's card is lower than the namer's.

   Phases added by this module:
     GROUP_EVAL             — all players placing slacker votes
     GROUP_EVAL_LEADER_TIE  — leader breaks a slacker-vote tie
     SIMPLE_BLAME_VOTE      — all players voting on who's to blame
     SIMPLE_BLAME_LEADER_TIE— leader breaks a blame-vote tie
     SIMPLE_SNITCH          — current snitcher names a target

   Events emitted:
     SLACKER_VOTE_CAST     { voterId, targetId }
     EVAL_VOTES_REVEALED   { counts, leaderId, votes }
     EVAL_TIE              { tied, leaderId }
     EVAL_TIE_BROKEN       { fromId, toId, leaderId }
     EVAL_ACCUSED          { accusedId, partyVal, isHighest, allVals }
     EVAL_CONFIRMED_SLACKER{ slackerId, kept, discarded, partyVal }
     EVAL_NOT_SLACKER       { accusedId, kept, discarded }
     EVAL_ROUND_DONE       { slackerTokens }

     FAIL_BLAME_VOTE_CAST  { voterId, targetId }
     FAIL_BLAME_VOTES_REVEALED { counts, leaderId, votes }
     FAIL_BLAME_TIE        { tied, leaderId }
     FAIL_BLAME_TIE_BROKEN { fromId, toId, leaderId }
     FAIL_BLAMED           { blamedId }
     SIMPLE_SNITCH_TURN    { snitcherId }
     SIMPLE_SNITCH_REVEALED{ snitcherId, targetId, targetCard, sVal, tVal }
     SIMPLE_SNITCH_FOUND_TOP { playerId }
     SIMPLE_SNITCH_STOPPED   { playerId, automatic }
     FAIL_BLAME_ROUND_DONE {}
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
// break the tie. The recipient becomes the sole accused.
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

  state.evalAccusedId = toId;
  _checkAccused(state, events);
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
    state.evalAccusedId = tied[0];
    _checkAccused(state, events);
  } else {
    // No votes cast (0-player edge case) — skip eval
    _finalizeEval(state, events);
  }
}

function _checkAccused(state, events) {
  const accusedId = state.evalAccusedId;
  const accused   = state.players[accusedId];
  const accusedPV = _topPartyValue(accused);

  const active  = activePlayers(state);
  const allVals = active.map(id => ({ id, partyVal: _topPartyValue(state.players[id]) }));
  const maxPV   = Math.max(...allVals.map(x => x.partyVal));
  const isHighest = accusedPV >= maxPV;

  events.push(evt('EVAL_ACCUSED', { accusedId, partyVal: accusedPV, isHighest, allVals }));

  // All OTHER players' Slacker votes are discarded outright — only the
  // accused's own pile of votes is ever in play from here on.
  for (const id of Object.keys(state.evalRoundCounts)) {
    if (id !== accusedId) state.evalRoundCounts[id] = 0;
  }

  if (isHighest) {
    _resolveAsSlacker(state, events, accusedId);
  } else {
    _resolveNotSlacker(state, events, accusedId);
  }
}

function _resolveAsSlacker(state, events, slackerId) {
  const slacker = state.players[slackerId];
  const held    = state.evalRoundCounts[slackerId] ?? 0;
  const cap     = Math.max(0, _topPartyValue(slacker));
  const kept    = Math.min(held, cap);
  const discarded = held - kept;
  state.evalRoundCounts[slackerId] = kept;

  events.push(evt('EVAL_CONFIRMED_SLACKER', {
    slackerId, kept, discarded, partyVal: _topPartyValue(slacker),
  }));
  addLog(state, {
    type:     'blame',
    text:     `${slacker.name} played the highest Party card and IS the Slacker! ` +
              `They keep ${kept} Slacker card${kept !== 1 ? 's' : ''}` +
              (discarded > 0 ? ` (${discarded} discarded — capped by their Party card).` : '.'),
    playerId: slackerId,
  });

  _finalizeEval(state, events);
}

function _resolveNotSlacker(state, events, accusedId) {
  const accused = state.players[accusedId];
  const held    = state.evalRoundCounts[accusedId] ?? 0;
  const kept    = Math.min(held, 1);
  const discarded = held - kept;
  state.evalRoundCounts[accusedId] = kept;

  events.push(evt('EVAL_NOT_SLACKER', { accusedId, kept, discarded }));
  addLog(state, {
    type:     'system',
    text:     `${accused.name} did not play the highest Party card — not the Slacker. ` +
              `They keep ${kept} Slacker card` +
              (discarded > 0 ? ` (${discarded} other Slacker card${discarded !== 1 ? 's' : ''} discarded).` : '.'),
    playerId: accusedId,
  });

  _finalizeEval(state, events);
}

function _finalizeEval(state, events) {
  // Move this round's (already-capped) Slacker cards into each player's
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

// =====================================================
//  "WHO'S TO BLAME?" — Fail vote + Snitch chain (after a FAIL)
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

  _beginSnitchChain(state, events, toId);
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
    _beginSnitchChain(state, events, tied[0]);
  } else {
    // No votes cast (0-player edge case) — skip straight to BREAK
    state.phase = 'BREAK';
    events.push(evt('FAIL_BLAME_ROUND_DONE', {}));
  }
}

// The blamed player always takes the Fail and must Snitch (no exceptions).
function _beginSnitchChain(state, events, blamedId) {
  const blamed = state.players[blamedId];
  events.push(evt('FAIL_BLAMED', { blamedId }));
  addLog(state, {
    type:     'fail',
    text:     `${blamed.name} is blamed for the failed project — takes a Fail and must Snitch!`,
    playerId: blamedId,
  });

  events.push(...applyIndividualFail(state, blamedId));
  markTopPartyForDiscard(state, blamedId);

  state.simpleSnitchedThisRound = [blamedId];
  state.phase = 'SIMPLE_SNITCH';
  _setSnitchCurrent(state, events, blamedId);
}

// ── simpleSnitchTarget ─────────────────────────────────────
// The current snitcher names another player. If that player's top Party
// card is >= the snitcher's, they take a Fail too and must Snitch onward
// (and if their card is the single highest in the game, the chain stops
// and they ALSO bank a bonus Slacker card). If their card is lower, the
// chain stops immediately and the SNITCHER (not the named player) banks
// the bonus Slacker card for having nowhere higher left to point.
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

  const targetTop = target.partyPile[target.partyPile.length - 1];
  if (targetTop) targetTop.revealed = true;

  const sVal = _topPartyValue(snitcher);
  const tVal = _topPartyValue(target);

  state.simpleSnitchedThisRound.push(targetId);

  events.push(evt('SIMPLE_SNITCH_REVEALED', { snitcherId, targetId, targetCard: targetTop, sVal, tVal }));

  if (tVal >= sVal) {
    addLog(state, {
      type:     'snitch',
      text:     `${snitcher.name} snitches on ${target.name} — ${target.name}(${tVal}) >= ${snitcher.name}(${sVal}). Takes a Fail!`,
      playerId: snitcherId,
    });
    events.push(...applyIndividualFail(state, targetId));
    markTopPartyForDiscard(state, targetId);

    const active = activePlayers(state);
    const maxVal = Math.max(...active.map(id => _topPartyValue(state.players[id])));

    if (tVal >= maxVal) {
      // Found the single highest (or equal-highest) Party card — chain
      // stops here, and the player who was found also banks a bonus card.
      state.slackerTokens[targetId] = (state.slackerTokens[targetId] ?? 0) + 1;
      events.push(evt('SIMPLE_SNITCH_FOUND_TOP', { playerId: targetId }));
      addLog(state, {
        type:     'blame',
        text:     `${target.name} played the highest Party card — the chain stops here! ${target.name} also takes a Slacker card.`,
        playerId: targetId,
      });
      _endSnitchChain(state, events);
    } else {
      _setSnitchCurrent(state, events, targetId);
    }
  } else {
    addLog(state, {
      type:     'snitch',
      text:     `${snitcher.name} snitches on ${target.name} — ${target.name}(${tVal}) < ${snitcher.name}(${sVal}). No fail — chain stops!`,
      playerId: snitcherId,
    });
    state.slackerTokens[snitcherId] = (state.slackerTokens[snitcherId] ?? 0) + 1;
    events.push(evt('SIMPLE_SNITCH_STOPPED', { playerId: snitcherId, automatic: false }));
    addLog(state, {
      type:     'blame',
      text:     `${snitcher.name} couldn't find anyone higher — takes a Slacker card.`,
      playerId: snitcherId,
    });
    _endSnitchChain(state, events);
  }

  return events;
}

// Players still eligible to be named by `currentId` in this chain.
function _eligibleSnitchTargets(state, currentId) {
  const already = state.simpleSnitchedThisRound || [];
  return activePlayers(state).filter(id => id !== currentId && !already.includes(id));
}

// Sets who must snitch next — or, if nobody is left to name, ends the
// chain automatically with that player banking the bonus Slacker card.
function _setSnitchCurrent(state, events, playerId) {
  if (_eligibleSnitchTargets(state, playerId).length === 0) {
    state.slackerTokens[playerId] = (state.slackerTokens[playerId] ?? 0) + 1;
    events.push(evt('SIMPLE_SNITCH_STOPPED', { playerId, automatic: true }));
    addLog(state, {
      type:     'blame',
      text:     `${state.players[playerId].name} has no one left to snitch on — chain stops! Takes a Slacker card.`,
      playerId,
    });
    _endSnitchChain(state, events);
    return;
  }
  state.simpleSnitchCurrentId = playerId;
  state.activePlayerId        = playerId;
  events.push(evt('SIMPLE_SNITCH_TURN', { snitcherId: playerId }));
}

function _endSnitchChain(state, events) {
  state.simpleSnitchCurrentId   = null;
  state.simpleSnitchedThisRound = [];
  state.phase = 'BREAK';
  applyEndOfSemesterDiscards(state, events);
  events.push(evt('FAIL_BLAME_ROUND_DONE', {}));
  addLog(state, { type: 'system', text: 'Round resolved — Fails applied, Party cards discarded.' });
}
