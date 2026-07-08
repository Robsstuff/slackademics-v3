/* =====================================================
   SLACKADEMICS — Simple Mode Engine

   Two independent post-round flows:

     Group Evaluation — runs after every PASS (including passes via
       Extra Credit). Players vote on who slacked off. The vote-winner
       reveals their top Party card:
         - Highest (or tied-highest) → they ARE the Slacker: discard
           that card. If the leader gifted EC this round, that EC is
           also revoked.
         - Not highest → evaluation fails; the voted player flips back.
           The real Slacker may then reveal themselves for +5 SSO.

     Who's to Blame? — runs after a project FAIL.
       Everyone already took a Group Fail. Vote selects one player
       ("the blame holder"); they immediately reveal their top Party
       card and ALWAYS discard it. If they hold the highest card they
       also take an Individual Fail. They may then start a Snitch chain:
         - Name a player: if that player's card is STRICTLY higher →
           they also discard; chain continues (they become the new
           snitch holder).
         - If not strictly higher → snitcher loses 1 EC (or 1 SSO if
           no EC) as a penalty; chain ends.
         - Or pass — chain ends, no penalty.
       There is NO self-reveal option in the fail context.

   Phases added by this module:
     GROUP_EVAL               — all players placing Voting cards
     GROUP_EVAL_LEADER_TIE    — leader breaks a slacker-vote tie
     SIMPLE_BLAME_VOTE        — all players voting on who's to blame
     SIMPLE_BLAME_LEADER_TIE  — leader breaks a blame-vote tie
     SIMPLE_FAIL_SNITCH       — blame holder (or chain holder) may snitch or pass
     SIMPLE_SELF_REVEAL       — real slacker may reveal (eval/pass context only)

   Events emitted (GROUP EVAL):
     SLACKER_VOTE_CAST         { voterId, targetId }
     EVAL_VOTES_REVEALED       { counts, leaderId, votes }
     EVAL_TIE                  { tied, leaderId }
     EVAL_TIE_BROKEN           { fromId, toId, leaderId }
     EVAL_CARD_REVEALED        { playerId, card, partyVal, maxVal, isSlacker }
     EVAL_CONFIRMED_SLACKER    { slackerId, partyVal }
     EVAL_EC_REVOKED           { recipientId }
     EVAL_NOT_SLACKER          { playerId, partyVal, maxVal }
     EVAL_SELF_REVEAL_OFFER    { realSlackerId }
     EVAL_SELF_REVEALED        { slackerId, card, partyVal }
     EVAL_SELF_REVEAL_DECLINED { slackerId }
     EVAL_ROUND_DONE           {}

   Events emitted (WHO'S TO BLAME):
     FAIL_BLAME_VOTE_CAST       { voterId, targetId }
     FAIL_BLAME_VOTES_REVEALED  { counts, leaderId, votes }
     FAIL_BLAME_TIE             { tied, leaderId }
     FAIL_BLAME_TIE_BROKEN      { fromId, toId, leaderId }
     FAIL_BLAMED                { blamedId, card, isSlacker, partyVal }
     FAIL_CONFIRMED_SLACKER     { blamedId, partyVal }
     FAIL_SNITCH_SUCCESS        { snitcherId, targetId, targetCard, targetVal }
     FAIL_SNITCH_FAILED         { snitcherId, targetId, targetCard, targetVal, penalty }
     FAIL_SNITCH_PASSED         { snitcherId }
     FAIL_BLAME_ROUND_DONE      {}
   ===================================================== */
'use strict';

import { addLog } from './state.js?v=3';
import {
  activePlayers, applyIndividualFail,
  markTopPartyForDiscard, applyEndOfSemesterDiscards,
} from './engine.js?v=3';

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
//  GROUP EVALUATION — Slacker vote (after every PASS)
// =====================================================

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
// (or tied-highest) among all active players they ARE the Slacker.
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

  // The most-voted player always discards their top Party card (they were called out)
  markTopPartyForDiscard(state, votedId);

  events.push(evt('EVAL_CARD_REVEALED', { playerId: votedId, card, partyVal: myVal, maxVal, isSlacker }));

  if (isSlacker) {
    events.push(evt('EVAL_CONFIRMED_SLACKER', { slackerId: votedId, partyVal: myVal }));
    addLog(state, {
      type:     'blame',
      text:     `${voted.name} has the highest Party card (${myVal}) — IS the Slacker! Discards their top Party card.`,
      playerId: votedId,
    });
    // Revoke the EC the leader gifted this round (if any)
    const giftedId = state.simpleECGiftPlayerId;
    if (giftedId) {
      const gifted = state.players[giftedId];
      if (gifted && gifted.extraCredits > 0) {
        gifted.extraCredits -= 1;
        events.push(evt('EVAL_EC_REVOKED', { recipientId: giftedId }));
        addLog(state, {
          type:     'fail',
          text:     `${gifted.name}'s Extra Credit from this round is revoked — the Slacker was caught!`,
          playerId: giftedId,
        });
      }
    }
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
  state.simpleECGiftPlayerId     = null;
  state.simpleVoteContext        = null;

  applyEndOfSemesterDiscards(state, events);
  events.push(evt('EVAL_ROUND_DONE', {}));
  addLog(state, {
    type: 'system',
    text: 'Group Evaluation complete — Voting cards returned.',
  });

  state.phase = 'BREAK';
}

// =====================================================
//  "WHO'S TO BLAME?" — Fail vote + Snitch chain
// =====================================================

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

  _startFailRevealPhase(state, events, toId);
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
    _startFailRevealPhase(state, events, tied[0]);
  } else {
    // 0-player edge case — skip straight to break
    applyEndOfSemesterDiscards(state, events);
    events.push(evt('FAIL_BLAME_ROUND_DONE', {}));
    state.phase = 'BREAK';
  }
}

// The blame-vote winner reveals their top Party card and immediately
// takes consequences: ALWAYS discard that card, PLUS Individual Fail
// if they are the highest (tied-highest). They then enter the snitch
// phase where they can try to pass the chain along.
function _startFailRevealPhase(state, events, blamedId) {
  const blamed = state.players[blamedId];
  const card   = blamed.partyPile[blamed.partyPile.length - 1];
  if (card) card.revealed = true;

  const active    = activePlayers(state);
  const myVal     = _topPartyValue(blamed);
  const maxVal    = active.length > 0
    ? Math.max(...active.map(id => _topPartyValue(state.players[id])))
    : myVal;
  const isSlacker = myVal >= maxVal;

  // Blamed player ALWAYS discards their top Party card
  markTopPartyForDiscard(state, blamedId);

  events.push(evt('FAIL_BLAMED', { blamedId, card, isSlacker, partyVal: myVal }));
  addLog(state, {
    type:     'fail',
    text:     `${blamed.name} is blamed! Reveals Party card${card ? ` (${_displayVal(card)})` : ''} — discards it.`,
    playerId: blamedId,
  });

  // If they ARE the slacker → also take Individual Fail
  if (isSlacker) {
    events.push(...applyIndividualFail(state, blamedId));
    events.push(evt('FAIL_CONFIRMED_SLACKER', { blamedId, partyVal: myVal }));
    addLog(state, {
      type:     'blame',
      text:     `${blamed.name} has the highest Party card (${myVal}) — the Slacker! Takes an Individual Fail.`,
      playerId: blamedId,
    });
  }

  // Enter snitch phase — blamed player holds the chain
  state.simpleAppealBlamedId    = blamedId;
  state.simpleSnitchCurrentId   = blamedId;
  state.simpleSnitchedThisRound = [blamedId];
  state.activePlayerId          = blamedId;
  state.phase                   = 'SIMPLE_FAIL_SNITCH';
}

// ── simpleFailSnitch ──────────────────────────────────────────
// Current chain holder names a target. If target's card is STRICTLY
// higher, they are also caught and the chain passes to them. If not,
// the snitcher pays a penalty (1 EC, then 1 SSO) and the chain ends.
export function simpleFailSnitch(state, snitcherId, targetId) {
  if (state.phase !== 'SIMPLE_FAIL_SNITCH')
    throw new Error(`simpleFailSnitch called in phase ${state.phase}`);
  if (state.simpleSnitchCurrentId !== snitcherId)
    throw new Error(`${snitcherId} is not the current snitch holder`);
  if (targetId === snitcherId)
    throw new Error('Cannot snitch on yourself');
  if ((state.simpleSnitchedThisRound ?? []).includes(targetId))
    throw new Error(`${targetId} has already been caught this round`);

  const events     = [];
  const snitcher   = state.players[snitcherId];
  const target     = state.players[targetId];
  const targetCard = target.partyPile[target.partyPile.length - 1];
  if (targetCard) targetCard.revealed = true;

  const snitcherVal = _topPartyValue(snitcher);
  const targetVal   = _topPartyValue(target);

  addLog(state, {
    type:     'snitch',
    text:     `${snitcher.name} snitches on ${target.name}! Reveals Party card: ${targetVal}.`,
    playerId: snitcherId,
  });

  if (targetVal > snitcherVal) {
    // SUCCESS — target is caught, chain continues
    markTopPartyForDiscard(state, targetId);
    events.push(evt('FAIL_SNITCH_SUCCESS', { snitcherId, targetId, targetCard, targetVal }));
    addLog(state, {
      type:     'blame',
      text:     `${target.name} (${targetVal}) > ${snitcher.name} (${snitcherVal}) — caught! Discards Party card. Chain continues.`,
      playerId: targetId,
    });
    state.simpleSnitchedThisRound.push(targetId);
    state.simpleSnitchCurrentId = targetId;
    state.activePlayerId        = targetId;
    // Phase stays SIMPLE_FAIL_SNITCH
  } else {
    // FAIL — snitcher pays a penalty, chain ends
    let penalty = 'none';
    if (snitcher.extraCredits > 0) {
      snitcher.extraCredits -= 1;
      penalty = 'ec';
    } else if ((state.successfulSlackOff[snitcherId] ?? 0) > 0) {
      state.successfulSlackOff[snitcherId] -= 1;
      penalty = 'sso';
    }
    events.push(evt('FAIL_SNITCH_FAILED', { snitcherId, targetId, targetCard, targetVal, penalty }));
    addLog(state, {
      type:     'fail',
      text:     `${target.name} (${targetVal}) is NOT higher than ${snitcher.name} (${snitcherVal}) — snitch fails! ${snitcher.name} loses ${penalty === 'ec' ? '1 Extra Credit' : penalty === 'sso' ? '1 Successful Slack Off' : 'nothing (nothing to lose)'}.`,
      playerId: snitcherId,
    });
    _endFailRound(state, events);
  }

  return events;
}

// ── simpleFailSnitchPass ──────────────────────────────────────
// Chain holder declines to snitch — chain ends, no penalty.
export function simpleFailSnitchPass(state, snitcherId) {
  if (state.phase !== 'SIMPLE_FAIL_SNITCH')
    throw new Error(`simpleFailSnitchPass called in phase ${state.phase}`);
  if (state.simpleSnitchCurrentId !== snitcherId)
    throw new Error(`${snitcherId} is not the current snitch holder`);

  const events  = [];
  const snitcher = state.players[snitcherId];

  events.push(evt('FAIL_SNITCH_PASSED', { snitcherId }));
  addLog(state, {
    type:     'system',
    text:     `${snitcher.name} passes — snitch chain ends.`,
    playerId: snitcherId,
  });

  _endFailRound(state, events);
  return events;
}

// ── simpleSelfReveal ───────────────────────────────────────────
// Real Slacker reveals themselves for +5 SSO (eval/pass context only).
export function simpleSelfReveal(state, slackerId, didReveal) {
  if (state.phase !== 'SIMPLE_SELF_REVEAL')
    throw new Error(`simpleSelfReveal called in phase ${state.phase}`);
  if (state.simpleSelfRevealPlayerId !== slackerId)
    throw new Error(`Not ${slackerId}'s self-reveal turn`);

  const events  = [];
  const slacker = state.players[slackerId];

  if (didReveal) {
    const card = slacker.partyPile[slacker.partyPile.length - 1];
    if (card) card.revealed = true;
    const partyVal = _topPartyValue(slacker);
    markTopPartyForDiscard(state, slackerId);
    state.successfulSlackOff[slackerId] = (state.successfulSlackOff[slackerId] ?? 0) + 1;

    events.push(evt('EVAL_SELF_REVEALED', { slackerId, card, partyVal }));
    addLog(state, {
      type:     'snitch',
      text:     `${slacker.name} reveals themselves as the Slacker! Party card: ${partyVal}. Earns +5 Successful Slack Off.`,
      playerId: slackerId,
    });
  } else {
    events.push(evt('EVAL_SELF_REVEAL_DECLINED', { slackerId }));
    addLog(state, {
      type:     'system',
      text:     `${slacker.name} stays hidden.`,
      playerId: slackerId,
    });
  }

  _finalizeEval(state, events);
  return events;
}

function _endFailRound(state, events) {
  state.simpleAppealBlamedId    = null;
  state.simpleSelfRevealPlayerId = null;
  state.simpleSnitchCurrentId   = null;
  state.simpleSnitchedThisRound = [];
  state.simpleVoteContext       = null;
  state.phase = 'BREAK';
  applyEndOfSemesterDiscards(state, events);
  events.push(evt('FAIL_BLAME_ROUND_DONE', {}));
  addLog(state, { type: 'system', text: 'Round resolved — Voting cards returned.' });
}
