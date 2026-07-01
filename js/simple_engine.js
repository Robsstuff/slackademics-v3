/* =====================================================
   SLACKADEMICS — Simple Mode Engine

   Two independent post-round flows:

     Group Evaluation — runs after a PASS without Extra Credit.
       Players vote on who slacked off using their Voting card.
       Ties are broken by the Project Leader moving one vote.
       The vote-winner reveals their top Party card:
         - If it is the highest (or equal-highest) among all active
           players → they ARE the Slacker and discard that card.
         - If not → evaluation fails; the player flips their card
           back. The real Slacker (not the voted player) may then
           choose to reveal themselves for +5 Successful Slack Off.

     Who's to Blame? — runs after a project FAIL.
       Every active player already took a simultaneous Group Fail
       (see engine.js resolveOutcome) before this flow starts.
       Players vote on who's to blame (ties broken the same way).
       The vote-winner is "blamed"; they reveal their top Party card
       and may appeal by naming one other player:
         - If that player holds the highest Party card → APPEAL
           SUCCEEDS: consequences (Individual Fail + discard Party
           card) transfer to them; the blamed player goes free.
         - If not → APPEAL FAILS: the blamed player keeps the
           Individual Fail and discards their Party card.
       If no appeal is made ("pass"), the blamed player takes the
       consequences directly. After a failed/passed appeal, the real
       Slacker (not the blamed player) may reveal themselves for +5.

   Copy cards have a Party value of 0. (Pairs sum to 8 on the effort
   side; copy+copy → the Party card contributes 0.)

   Phases added by this module:
     GROUP_EVAL               — all players placing Voting cards
     GROUP_EVAL_LEADER_TIE    — leader breaks a slacker-vote tie
     SIMPLE_BLAME_VOTE        — all players voting on who's to blame
     SIMPLE_BLAME_LEADER_TIE  — leader breaks a blame-vote tie
     SIMPLE_APPEAL            — blamed player may name one other player
     SIMPLE_SELF_REVEAL       — real slacker may reveal themselves

   Events emitted:
     SLACKER_VOTE_CAST         { voterId, targetId }
     EVAL_VOTES_REVEALED       { counts, leaderId, votes }
     EVAL_TIE                  { tied, leaderId }
     EVAL_TIE_BROKEN           { fromId, toId, leaderId }
     EVAL_CARD_REVEALED        { playerId, card, partyVal, maxVal, isSlacker }
     EVAL_CONFIRMED_SLACKER    { slackerId, partyVal }
     EVAL_NOT_SLACKER          { playerId, partyVal, maxVal }
     EVAL_SELF_REVEAL_OFFER    { realSlackerId }
     EVAL_SELF_REVEALED        { slackerId, card, partyVal }
     EVAL_SELF_REVEAL_DECLINED { slackerId }
     EVAL_ROUND_DONE           {}

     FAIL_BLAME_VOTE_CAST       { voterId, targetId }
     FAIL_BLAME_VOTES_REVEALED  { counts, leaderId, votes }
     FAIL_BLAME_TIE             { tied, leaderId }
     FAIL_BLAME_TIE_BROKEN      { fromId, toId, leaderId }
     FAIL_BLAMED                { blamedId, card }
     FAIL_APPEAL_REVEALED       { blamedId, targetId, targetCard, targetVal, maxVal, isSlacker }
     FAIL_APPEAL_SUCCESS        { blamedId, targetId }
     FAIL_SLACKER_FOUND         { playerId, partyVal }
     FAIL_APPEAL_FAIL           { blamedId, targetId }
     FAIL_APPEAL_PASSED         { blamedId }
     FAIL_SELF_REVEAL_OFFER     { realSlackerId }
     FAIL_SELF_REVEALED         { slackerId, card, partyVal }
     FAIL_SELF_REVEAL_DECLINED  { slackerId }
     FAIL_BLAME_ROUND_DONE      {}
   ===================================================== */
'use strict';

import { addLog } from './state.js';
import {
  activePlayers, applyIndividualFail,
  markTopPartyForDiscard, applyEndOfSemesterDiscards,
} from './engine.js';

function evt(type, payload = {}) { return { type, ...payload }; }

// ── Party-card value from project card ───────────────────────
// Each pair sums to 8 (effort side); copy+copy → Party value 0.
export function partyCardValue(projectCard) {
  if (!projectCard) return -1;
  if (projectCard.type === 'copy') return 0;
  return 8 - Number(projectCard.value ?? 0);
}

// ── Top Party Pile card's numeric value (Copy = 0) ───────────
function _topPartyValue(player) {
  const card = player.partyPile[player.partyPile.length - 1];
  if (!card) return -1;
  return card.type === 'copy' ? 0 : Number(card.value ?? 0);
}

function _displayVal(card) {
  return card.type === 'copy' ? 'X2 Copy' : card.value;
}

// =====================================================
//  GROUP EVALUATION — Slacker vote (after a PASS)
// =====================================================

// ── castSlackerVote ───────────────────────────────────────────
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
    text:     `${state.players[voterId].name} placed a Voting card.`,
    playerId: voterId,
  });

  if (state.evalVotersRemaining.length === 0) {
    _resolveAllVotes(state, events);
  }

  return events;
}

// ── leaderBreakTie ────────────────────────────────────────────
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
    text: `${leader.name} moves a Voting card from ${from?.name ?? fromId} to ${to.name} to break the tie.`,
  });

  _revealAndCheck(state, events, toId);
  return events;
}

// ── Internal helpers ──────────────────────────────────────────

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
    state.evalTiedPlayers = tied;
    state.phase = 'GROUP_EVAL_LEADER_TIE';
    state.activePlayerId = state.projectLeaderId;
    events.push(evt('EVAL_TIE', { tied, leaderId: state.projectLeaderId }));
    addLog(state, {
      type: 'system',
      text: `Tied vote! ${state.players[state.projectLeaderId].name} must move one Voting card to break the tie.`,
    });
  } else if (tied.length === 1) {
    _revealAndCheck(state, events, tied[0]);
  } else {
    _finalizeEval(state, events);
  }
}

// The voted player reveals their top Party card. If it is the highest
// (or tied-highest) among all active players they ARE the Slacker and
// must discard it. Otherwise evaluation fails and the real Slacker may
// choose to self-reveal.
function _revealAndCheck(state, events, votedId) {
  const voted = state.players[votedId];
  const card  = voted.partyPile[voted.partyPile.length - 1];
  if (card) card.revealed = true;

  const active    = activePlayers(state);
  const myVal     = _topPartyValue(voted);
  const maxVal    = active.length > 0
    ? Math.max(...active.map(id => _topPartyValue(state.players[id])))
    : myVal;
  const isSlacker = myVal >= maxVal;

  events.push(evt('EVAL_CARD_REVEALED', { playerId: votedId, card, partyVal: myVal, maxVal, isSlacker }));

  if (isSlacker) {
    markTopPartyForDiscard(state, votedId);
    events.push(evt('EVAL_CONFIRMED_SLACKER', { slackerId: votedId, partyVal: myVal }));
    addLog(state, {
      type:     'blame',
      text:     `${voted.name} has the highest Party card (${myVal}) — IS the Slacker! Discards their top Party card.`,
      playerId: votedId,
    });
    _finalizeEval(state, events);
  } else {
    events.push(evt('EVAL_NOT_SLACKER', { playerId: votedId, partyVal: myVal, maxVal }));
    addLog(state, {
      type:     'system',
      text:     `${voted.name} (${myVal}) is NOT the highest (max: ${maxVal}) — evaluation fails!`,
      playerId: votedId,
    });
    _offerEvalSelfReveal(state, events, votedId);
  }
}

function _offerEvalSelfReveal(state, events, excludedId) {
  const active = activePlayers(state);
  let realSlackerId = null;
  let maxVal = -Infinity;
  for (const id of active) {
    if (id === excludedId) continue;
    const val = _topPartyValue(state.players[id]);
    if (val > maxVal) { maxVal = val; realSlackerId = id; }
  }

  if (!realSlackerId) {
    _finalizeEval(state, events);
    return;
  }

  state.simpleSelfRevealPlayerId = realSlackerId;
  state.activePlayerId           = realSlackerId;
  state.phase                    = 'SIMPLE_SELF_REVEAL';
  events.push(evt('EVAL_SELF_REVEAL_OFFER', { realSlackerId }));
  addLog(state, {
    type:     'system',
    text:     `${state.players[realSlackerId].name} may reveal themselves as the real Slacker for +5 points.`,
    playerId: realSlackerId,
  });
}

function _finalizeEval(state, events) {
  state.simpleSelfRevealPlayerId = null;
  state.evalRoundCounts          = {};
  state.evalAccusedId            = null;

  events.push(evt('EVAL_ROUND_DONE', {}));
  addLog(state, {
    type: 'system',
    text: 'Group Evaluation complete — Voting cards returned.',
  });

  state.phase = 'BREAK';
}

// =====================================================
//  "WHO'S TO BLAME?" — Fail vote + Appeal (after a FAIL)
// =====================================================

// ── castFailBlameVote ─────────────────────────────────────────
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

// ── leaderBreakFailTie ────────────────────────────────────────
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

  _startAppealPhase(state, events, toId);
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
    _startAppealPhase(state, events, tied[0]);
  } else {
    // 0-player edge case — skip
    state.phase = 'BREAK';
    applyEndOfSemesterDiscards(state, events);
    events.push(evt('FAIL_BLAME_ROUND_DONE', {}));
  }
}

// Blamed player reveals their top Party card and enters SIMPLE_APPEAL.
// Consequences are NOT applied yet — deferred until the appeal resolves
// so we never need to undo anything.
function _startAppealPhase(state, events, blamedId) {
  const blamed = state.players[blamedId];
  const card   = blamed.partyPile[blamed.partyPile.length - 1];
  if (card) card.revealed = true;

  events.push(evt('FAIL_BLAMED', { blamedId, card }));
  addLog(state, {
    type:     'fail',
    text:     `${blamed.name} is blamed! Reveals Party card${card ? ` (${_displayVal(card)})` : ''} — may appeal.`,
    playerId: blamedId,
  });

  state.simpleAppealBlamedId = blamedId;
  state.activePlayerId       = blamedId;
  state.phase                = 'SIMPLE_APPEAL';
}

// ── simpleAppeal ───────────────────────────────────────────────
// Blamed player names another player. If that player holds the highest
// (or tied-highest) Party card, consequences transfer. Otherwise the
// blamed player keeps their Individual Fail.
export function simpleAppeal(state, blamedId, targetId) {
  if (state.phase !== 'SIMPLE_APPEAL')
    throw new Error(`simpleAppeal called in phase ${state.phase}`);
  if (state.simpleAppealBlamedId !== blamedId)
    throw new Error(`${blamedId} is not the blamed player`);
  if (targetId === blamedId)
    throw new Error('Cannot appeal to yourself');

  const events     = [];
  const blamed     = state.players[blamedId];
  const target     = state.players[targetId];
  const targetCard = target.partyPile[target.partyPile.length - 1];
  if (targetCard) targetCard.revealed = true;

  const active    = activePlayers(state);
  const targetVal = _topPartyValue(target);
  const maxVal    = active.length > 0
    ? Math.max(...active.map(id => _topPartyValue(state.players[id])))
    : targetVal;
  const isSlacker = targetVal >= maxVal;

  events.push(evt('FAIL_APPEAL_REVEALED', {
    blamedId, targetId, targetCard, targetVal, maxVal, isSlacker,
  }));

  if (isSlacker) {
    // Consequences transfer to target
    events.push(evt('FAIL_APPEAL_SUCCESS', { blamedId, targetId }));
    events.push(...applyIndividualFail(state, targetId));
    markTopPartyForDiscard(state, targetId);
    events.push(evt('FAIL_SLACKER_FOUND', { playerId: targetId, partyVal: targetVal }));
    addLog(state, {
      type:     'blame',
      text:     `${target.name} has the highest Party card (${targetVal}) — APPEAL SUCCEEDS! Consequences transfer.`,
      playerId: targetId,
    });
    _endFailRound(state, events);
  } else {
    // Appeal fails — blamed keeps consequences
    events.push(evt('FAIL_APPEAL_FAIL', { blamedId, targetId }));
    events.push(...applyIndividualFail(state, blamedId));
    markTopPartyForDiscard(state, blamedId);
    addLog(state, {
      type:     'fail',
      text:     `${target.name} (${targetVal}) is not the highest (max: ${maxVal}). Appeal fails — ${blamed.name} keeps the Individual Fail.`,
      playerId: blamedId,
    });
    _offerFailSelfReveal(state, events);
  }

  return events;
}

// ── simpleAppealPass ───────────────────────────────────────────
// Blamed player declines to appeal — accepts the Individual Fail.
export function simpleAppealPass(state, blamedId) {
  if (state.phase !== 'SIMPLE_APPEAL')
    throw new Error(`simpleAppealPass called in phase ${state.phase}`);
  if (state.simpleAppealBlamedId !== blamedId)
    throw new Error(`${blamedId} is not the blamed player`);

  const events = [];
  const blamed  = state.players[blamedId];

  events.push(evt('FAIL_APPEAL_PASSED', { blamedId }));
  events.push(...applyIndividualFail(state, blamedId));
  markTopPartyForDiscard(state, blamedId);
  addLog(state, {
    type:     'fail',
    text:     `${blamed.name} passes on the appeal — takes the Individual Fail.`,
    playerId: blamedId,
  });
  _offerFailSelfReveal(state, events);

  return events;
}

// ── simpleSelfReveal ───────────────────────────────────────────
// The real Slacker (highest Party card) may reveal themselves for
// +5 Successful Slack Off points. Works for both eval context and
// fail context (detected via simpleAppealBlamedId !== null).
export function simpleSelfReveal(state, slackerId, didReveal) {
  if (state.phase !== 'SIMPLE_SELF_REVEAL')
    throw new Error(`simpleSelfReveal called in phase ${state.phase}`);
  if (state.simpleSelfRevealPlayerId !== slackerId)
    throw new Error(`Not ${slackerId}'s self-reveal turn`);

  const events        = [];
  const slacker       = state.players[slackerId];
  const isFailContext = state.simpleAppealBlamedId !== null;

  if (didReveal) {
    const card = slacker.partyPile[slacker.partyPile.length - 1];
    if (card) card.revealed = true;
    const partyVal = _topPartyValue(slacker);
    markTopPartyForDiscard(state, slackerId);
    state.successfulSlackOff[slackerId] = (state.successfulSlackOff[slackerId] ?? 0) + 1;

    const evType = isFailContext ? 'FAIL_SELF_REVEALED' : 'EVAL_SELF_REVEALED';
    events.push(evt(evType, { slackerId, card, partyVal }));
    addLog(state, {
      type:     'snitch',
      text:     `${slacker.name} reveals themselves as the Slacker! Party card: ${partyVal}. Earns +5 Successful Slack Off.`,
      playerId: slackerId,
    });
  } else {
    const evType = isFailContext ? 'FAIL_SELF_REVEAL_DECLINED' : 'EVAL_SELF_REVEAL_DECLINED';
    events.push(evt(evType, { slackerId }));
    addLog(state, {
      type:     'system',
      text:     `${slacker.name} stays hidden.`,
      playerId: slackerId,
    });
  }

  if (isFailContext) {
    _endFailRound(state, events);
  } else {
    _finalizeEval(state, events);
  }

  return events;
}

// Real Slacker (highest card, must NOT be the blamed player) may reveal.
function _offerFailSelfReveal(state, events) {
  const blamedId = state.simpleAppealBlamedId;
  const active   = activePlayers(state);
  let realSlackerId = null;
  let maxVal = -Infinity;
  for (const id of active) {
    if (id === blamedId) continue;
    const val = _topPartyValue(state.players[id]);
    if (val > maxVal) { maxVal = val; realSlackerId = id; }
  }

  if (!realSlackerId) {
    _endFailRound(state, events);
    return;
  }

  state.simpleSelfRevealPlayerId = realSlackerId;
  state.activePlayerId           = realSlackerId;
  state.phase                    = 'SIMPLE_SELF_REVEAL';
  events.push(evt('FAIL_SELF_REVEAL_OFFER', { realSlackerId }));
  addLog(state, {
    type:     'system',
    text:     `${state.players[realSlackerId].name} may reveal themselves as the real Slacker for +5 points.`,
    playerId: realSlackerId,
  });
}

function _endFailRound(state, events) {
  state.simpleAppealBlamedId     = null;
  state.simpleSelfRevealPlayerId = null;
  state.phase = 'BREAK';
  applyEndOfSemesterDiscards(state, events);
  events.push(evt('FAIL_BLAME_ROUND_DONE', {}));
  addLog(state, { type: 'system', text: 'Round resolved — Voting cards returned.' });
}
