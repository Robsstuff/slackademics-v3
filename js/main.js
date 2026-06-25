/* =====================================================
   SLACKADEMICS — Main Entry Point (Rulebook v2)
   ===================================================== */
'use strict';

import { createState, totalFails }   from './state.js';
import {
  playPair, revealPhase, letItRide, useLeadershipSkill,
  completeRealignSkill, accusePlayer, castVote, skipBlame,
  snitchTarget, snitchPass, semesterBreak, drawPair,
  awardLeaderExtraCredit,
  getValidActions, activePlayers, getAvailablePairKeys,
}                                     from './engine.js';
import {
  castSlackerVote, leaderBreakTie,
  castFailBlameVote, leaderBreakFailTie, simpleSnitchTarget,
}                                     from './simple_engine.js';
import { getAIAction }                from './ai.js';
import {
  buildStepsFromEvents, enqueueAll,
  run        as runQueue,
  isRunning  as queueBusy,
  setHumanId as queueSetHuman,
  setOnDone  as queueSetOnDone,
  clearQueue,
}                                     from './animQueue.js';
import {
  renderAll, renderScoreboard, renderLog, getSelectedCardId,
  setCardClickCallback,
}                                     from './renderer.js';
import { sleep, uid }                 from './utils.js';

// ── Module globals ─────────────────────────────────────────
let _state          = null;
let _humanId        = null;
let _lobbyDifficulty = 1.0;  // set from lobby difficulty buttons

// Staged pair for human player (UI state, not game state)
let _stagedProject = null;  // card id
let _stagedParty   = null;  // card id

// Returns 0 in fast (no-animation) mode, otherwise the given ms
const _delay = ms => window._slk_anim === false ? 0 : ms;
const AI_THINK_DELAY = 300;

// ─────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────
export function init() {
  _on('btn-continue',     () => _handleContinue());
  _on('btn-let-it-ride',  () => _humanLetItRide());
  _on('btn-skill-faceup', () => _humanUseSkill('faceup'));
  _on('btn-skill-facedown',() => _humanUseSkill('facedown'));
  _on('btn-blame',        () => _openBlameOverlay());
  _on('btn-vote-accused', () => _humanVote(state => state.blameAccusedId));
  _on('btn-vote-leader',  () => _humanVote(state => state.projectLeaderId));
  _on('btn-snitch-target', () => _openSnitchOverlay());
  _on('btn-snitch-pass',  () => _humanSnitchPass());
  _on('btn-scores',       () => _goScoreboard());
}

// ─────────────────────────────────────────────────────────
//  GAME START
// ─────────────────────────────────────────────────────────
export function startGame(lobbyPlayers, gameMode = 'traditional', options = {}) {
  const configs = lobbyPlayers.map((p, i) => ({
    id:      'p' + (i + 1),
    name:    p.name,
    isHuman: !!p.isHuman,
    aiMode:  p.aiMode || 'regular',
  }));

  _humanId = configs.find(c => c.isHuman)?.id ?? configs[0].id;
  if (window._slk_diff != null) _lobbyDifficulty = window._slk_diff;
  const coLeadFailMode = window._slk_colead_fail || 'exam_fail';
  _state = createState(configs, _lobbyDifficulty, coLeadFailMode, gameMode, options);
  _stagedProject = null;
  _stagedParty   = null;

  queueSetHuman(_humanId);
  queueSetOnDone(_afterQueueDrain);
  setCardClickCallback(_onHumanCardClick);

  const logList = document.getElementById('log-list');
  if (logList) { logList.innerHTML = ''; logList.dataset.logCount = '0'; }

  renderAll(_state, _humanId);
  _goScreen('game');
  setTimeout(() => _advance(), _delay(400));
}

// ─────────────────────────────────────────────────────────
//  GAME LOOP
// ─────────────────────────────────────────────────────────
function _advance() {
  if (!_state || queueBusy()) return;

  // Extra credit recipient pick can be pending while phase is still DEADLINE
  // (it's set inside resolveOutcome before any phase transition to BREAK) —
  // check it before the phase switch so it isn't skipped.
  if (_state.pendingSkillStep === 'extra-credit-pick') {
    const leaderId = _state.projectLeaderId;
    const leader   = _state.players[leaderId];
    if (leader && !leader.isExpelled) {
      if (leader.isHuman) {
        setTimeout(() => _openExtraCreditOverlay(), _delay(300));
      } else {
        const action = getAIAction(_state, leaderId);
        if (action?.type === 'AWARD_EXTRA_CREDIT') {
          setTimeout(() => {
            try {
              _dispatchEvents(awardLeaderExtraCredit(_state, {
                leaderId, recipientId: action.recipientId,
              }));
            } catch (e) { console.warn(e); }
          }, _delay(AI_THINK_DELAY));
        }
      }
    }
    return;
  }

  const phase = _state.phase;

  switch (phase) {
    case 'GAMEOVER':
      setTimeout(_goScoreboard, 1200);
      return;

    case 'REVEAL': {
      // Auto-reveal (pause skipped in fast mode)
      setTimeout(() => _dispatchEvents(revealPhase(_state)), _delay(900));
      return;
    }

    case 'BREAK': {
      // Simple mode: auto-advance with no card draw
      if (_state.gameMode === 'simple') {
        setTimeout(() => _dispatchEvents(semesterBreak(_state)), _delay(1200));
        return;
      }
      const human = _humanId ? _state.players[_humanId] : null;
      if (human && !human.isExpelled) return;   // human clicks Continue
      setTimeout(() => _dispatchEvents(semesterBreak(_state)), _delay(AI_THINK_DELAY));
      return;
    }

    case 'GROUP_EVAL': {
      // Show slacker vote overlay for human; auto-vote for AIs
      const humanPlayer = _humanId ? _state.players[_humanId] : null;
      const humanMustVote = humanPlayer && !humanPlayer.isExpelled &&
        _state.evalVotersRemaining?.includes(_humanId);
      if (humanMustVote) {
        setTimeout(() => _openSlackerVoteOverlay(), _delay(300));
      } else {
        // Human already voted or is expelled — run remaining AI votes
        setTimeout(() => _runAISlackerVotes(), _delay(AI_THINK_DELAY));
      }
      return;
    }

    case 'GROUP_EVAL_LEADER_TIE': {
      const leader = _state.players[_state.projectLeaderId];
      if (leader?.isHuman) {
        setTimeout(() => _openTieBreakOverlay(), _delay(300));
      } else {
        const action = getAIAction(_state, _state.projectLeaderId);
        if (action?.type === 'LEADER_TIE_BREAK') {
          setTimeout(() => {
            try { _dispatchEvents(leaderBreakTie(_state, action.fromId, action.toId)); }
            catch (e) { console.warn(e); }
          }, _delay(AI_THINK_DELAY));
        }
      }
      return;
    }

    case 'SIMPLE_BLAME_VOTE': {
      // Show "who's to blame" vote overlay for human; auto-vote for AIs
      const humanPlayer = _humanId ? _state.players[_humanId] : null;
      const humanMustVote = humanPlayer && !humanPlayer.isExpelled &&
        _state.failVoteVotersRemaining?.includes(_humanId);
      if (humanMustVote) {
        setTimeout(() => _openFailBlameVoteOverlay(), _delay(300));
      } else {
        setTimeout(() => _runAIFailBlameVotes(), _delay(AI_THINK_DELAY));
      }
      return;
    }

    case 'SIMPLE_BLAME_LEADER_TIE': {
      const leader = _state.players[_state.projectLeaderId];
      if (leader?.isHuman) {
        setTimeout(() => _openFailTieBreakOverlay(), _delay(300));
      } else {
        const action = getAIAction(_state, _state.projectLeaderId);
        if (action?.type === 'FAIL_LEADER_TIE_BREAK') {
          setTimeout(() => {
            try { _dispatchEvents(leaderBreakFailTie(_state, action.fromId, action.toId)); }
            catch (e) { console.warn(e); }
          }, _delay(AI_THINK_DELAY));
        }
      }
      return;
    }

    case 'SIMPLE_SNITCH': {
      const snitcher = _state.simpleSnitchCurrentId ? _state.players[_state.simpleSnitchCurrentId] : null;
      if (snitcher?.isHuman) {
        setTimeout(() => _openSimpleSnitchOverlay(), _delay(400));
      } else if (snitcher) {
        const action = getAIAction(_state, _state.simpleSnitchCurrentId);
        if (action?.type === 'SIMPLE_SNITCH_TARGET') {
          setTimeout(() => {
            try {
              _dispatchEvents(simpleSnitchTarget(_state, _state.simpleSnitchCurrentId, action.targetId));
            } catch (e) { console.warn(e); }
          }, _delay(AI_THINK_DELAY));
        }
      }
      return;
    }
  }

  // Phases that require an active player
  const activeId = _state.activePlayerId;
  if (!activeId) return;

  const active = _state.players[activeId];
  if (!active || active.isExpelled) return;

  // Human's turn — leave it to them
  if (active.isHuman) return;

  // AI turn — instant in PLAYING phase (cards fly together after human plays)
  const playDelay = _state.phase === 'PLAYING' ? 0 : _delay(AI_THINK_DELAY);
  setTimeout(() => _runAITurn(activeId), playDelay);
}

function _afterQueueDrain() {
  _hideAIThinking();

  if (_state?.phase === 'BLAME_VOTE' &&
      _state.blameVotersRemaining?.includes(_humanId)) {
    setTimeout(() => _openBlameVoteOverlay(), _delay(150));
  }

  // GROUP_EVAL / SIMPLE_BLAME_VOTE / SIMPLE_SNITCH: overlays fire via _advance()

  _advance();
}

// ─────────────────────────────────────────────────────────
//  AI TURNS
// ─────────────────────────────────────────────────────────
async function _runAITurn(playerId) {
  if (!_state || queueBusy()) return;

  const aiPlayer = _state.players[playerId];
  if (window._slk_anim !== false) _showAIThinking(aiPlayer?.name ?? '');

  let action;
  let events = [];
  try {
    action = getAIAction(_state, playerId);
    if (!action) {
      _hideAIThinking();
      setTimeout(() => _advance(), 100);
      return;
    }

    switch (action.type) {

      case 'PLAY_PAIR':
        events = playPair(_state, {
          playerId,
          projectCardId: action.projectCardId,
          partyCardId:   action.partyCardId,
        });
        break;

      case 'REVEAL':
        events = revealPhase(_state);
        break;

      case 'LET_IT_RIDE':
        events = letItRide(_state);
        break;

      case 'USE_SKILL':
        events = useLeadershipSkill(_state, action.skillChoice);
        // If skill needs a target, immediately act
        if (_state.pendingSkillStep === 'realign-pick-target') {
          const targetAction = getAIAction(_state, playerId);
          if (targetAction?.type === 'PICK_REALIGN_TARGET') {
            const more = completeRealignSkill(_state, targetAction.targetId);
            events.push(...more);
          }
        }
        break;

      case 'PICK_REALIGN_TARGET':
        events = completeRealignSkill(_state, action.targetId);
        break;

      case 'AWARD_EXTRA_CREDIT':
        events = awardLeaderExtraCredit(_state, {
          leaderId:    playerId,
          recipientId: action.recipientId,
        });
        break;

      case 'ACCUSE':
        events = accusePlayer(_state, {
          accuserId: playerId,
          accusedId: action.accusedId,
        });
        // If all voters are AI, cascade auto-votes immediately
        if (_state.phase === 'BLAME_VOTE') {
          events.push(..._runAIVotingCascade());
        }
        break;

      case 'SKIP_BLAME':
        events = skipBlame(_state);
        break;

      case 'CAST_VOTE':
        events = castVote(_state, { voterId: playerId, voteFor: action.voteFor });
        if (_state.phase === 'BLAME_VOTE') {
          events.push(..._runAIVotingCascade());
        }
        break;

      case 'SNITCH_TARGET':
        events = snitchTarget(_state, { snitcherId: playerId, targetId: action.targetId });
        break;

      case 'SNITCH_PASS':
        events = snitchPass(_state);
        break;

      case 'NEXT_SEMESTER':
        events = semesterBreak(_state);
        break;

      case 'DRAW_PAIR':
        if (action.key) {
          events = drawPair(_state, { playerId, key: action.key });
          // Cascade if next drawer is also AI
          while (_state.phase === 'BREAK_DRAW' && _state.breakDrawCurrent) {
            const nextAI = _state.players[_state.breakDrawCurrent];
            if (!nextAI || nextAI.isHuman) break;
            const nextAction = getAIAction(_state, _state.breakDrawCurrent);
            if (nextAction?.type === 'DRAW_PAIR' && nextAction.key) {
              events.push(...drawPair(_state, { playerId: _state.breakDrawCurrent, key: nextAction.key }));
            } else {
              break;
            }
          }
        }
        break;

      case 'VIEW_SCORES':
        _hideAIThinking();
        _goScoreboard();
        return;

      case 'SLACKER_VOTE': {
        const voteEvents = castSlackerVote(_state, playerId, action.targetId);
        // Cascade remaining AI voters
        while (_state.phase === 'GROUP_EVAL' && _state.evalVotersRemaining?.length > 0) {
          const nextId = _state.evalVotersRemaining[0];
          const nextP  = _state.players[nextId];
          if (!nextP || nextP.isHuman) break;
          const nextAction = getAIAction(_state, nextId);
          if (nextAction?.type === 'SLACKER_VOTE') {
            voteEvents.push(...castSlackerVote(_state, nextId, nextAction.targetId));
          } else { break; }
        }
        events = voteEvents;
        break;
      }

      case 'LEADER_TIE_BREAK':
        events = leaderBreakTie(_state, action.fromId, action.toId);
        break;

      case 'FAIL_BLAME_VOTE': {
        const voteEvents = castFailBlameVote(_state, playerId, action.targetId);
        while (_state.phase === 'SIMPLE_BLAME_VOTE' && _state.failVoteVotersRemaining?.length > 0) {
          const nextId = _state.failVoteVotersRemaining[0];
          const nextP  = _state.players[nextId];
          if (!nextP || nextP.isHuman) break;
          const nextAction = getAIAction(_state, nextId);
          if (nextAction?.type === 'FAIL_BLAME_VOTE') {
            voteEvents.push(...castFailBlameVote(_state, nextId, nextAction.targetId));
          } else { break; }
        }
        events = voteEvents;
        break;
      }

      case 'FAIL_LEADER_TIE_BREAK':
        events = leaderBreakFailTie(_state, action.fromId, action.toId);
        break;

      case 'SIMPLE_SNITCH_TARGET':
        events = simpleSnitchTarget(_state, playerId, action.targetId);
        break;
    }
  } catch (err) {
    console.error('[main] AI action error:', err);
    _hideAIThinking();
    setTimeout(() => _advance(), 300);
    return;
  }

  if (events.length > 0) {
    _dispatchEvents(events);
  } else {
    _hideAIThinking();
    setTimeout(() => _advance(), 100);
  }
}

// Run all remaining AI slacker votes (called after human votes or is expelled)
function _runAISlackerVotes() {
  if (!_state || _state.phase !== 'GROUP_EVAL') return;
  const events = [];
  while (_state.phase === 'GROUP_EVAL' && _state.evalVotersRemaining?.length > 0) {
    const nextId = _state.evalVotersRemaining[0];
    const nextP  = _state.players[nextId];
    if (!nextP || nextP.isHuman) break;
    const action = getAIAction(_state, nextId);
    if (action?.type === 'SLACKER_VOTE') {
      try {
        events.push(...castSlackerVote(_state, nextId, action.targetId));
      } catch (e) { console.warn(e); break; }
    } else { break; }
  }
  if (events.length > 0) _dispatchEvents(events);
}

// Run all remaining AI "who's to blame" votes (called after human votes or is expelled)
function _runAIFailBlameVotes() {
  if (!_state || _state.phase !== 'SIMPLE_BLAME_VOTE') return;
  const events = [];
  while (_state.phase === 'SIMPLE_BLAME_VOTE' && _state.failVoteVotersRemaining?.length > 0) {
    const nextId = _state.failVoteVotersRemaining[0];
    const nextP  = _state.players[nextId];
    if (!nextP || nextP.isHuman) break;
    const action = getAIAction(_state, nextId);
    if (action?.type === 'FAIL_BLAME_VOTE') {
      try {
        events.push(...castFailBlameVote(_state, nextId, action.targetId));
      } catch (e) { console.warn(e); break; }
    } else { break; }
  }
  if (events.length > 0) _dispatchEvents(events);
}

// If next voters in queue are AI, auto-vote them
function _runAIVotingCascade() {
  const events = [];
  while (_state.phase === 'BLAME_VOTE' && _state.blameVotersRemaining.length > 0) {
    const nextVoterId = _state.blameVotersRemaining[0];
    const nextVoter   = _state.players[nextVoterId];
    if (!nextVoter || nextVoter.isHuman) break;
    const a = getAIAction(_state, nextVoterId);
    if (a?.type === 'CAST_VOTE') {
      events.push(...castVote(_state, { voterId: nextVoterId, voteFor: a.voteFor }));
    } else {
      break;
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────
//  HUMAN PLAY PAIR  (one-click → cascades all remaining AI simultaneously)
// ─────────────────────────────────────────────────────────
function _onHumanCardClick(partyCardId, projectCardId) {
  if (!_state || queueBusy()) return;
  if (_state.phase !== 'PLAYING' || _state.activePlayerId !== _humanId) return;

  let allEvents;
  try {
    allEvents = playPair(_state, {
      playerId:      _humanId,
      projectCardId,
      partyCardId,
    });
  } catch (err) {
    console.warn('[main] playPair error:', err.message);
    const strip = document.getElementById('sel-strip');
    if (strip) strip.innerHTML =
      `<span class="sel-desc" style="color:var(--accent)">${err.message}</span>`;
    return;
  }

  // Cascade remaining AI players' plays so all cards fly simultaneously
  while (_state.phase === 'PLAYING') {
    const nextId = _state.activePlayerId;
    const nextP  = nextId ? _state.players[nextId] : null;
    if (!nextP || nextP.isHuman || nextP.isExpelled) break;
    let cascadeAction;
    try {
      cascadeAction = getAIAction(_state, nextId);
    } catch (err) {
      console.warn('[main] AI cascade getAIAction error:', err);
      break;
    }
    if (cascadeAction?.type !== 'PLAY_PAIR') break;
    try {
      allEvents.push(...playPair(_state, {
        playerId:      nextId,
        projectCardId: cascadeAction.projectCardId,
        partyCardId:   cascadeAction.partyCardId,
      }));
    } catch (err) {
      console.warn('[main] AI cascade error:', err.message);
      break;
    }
  }

  _dispatchEvents(allEvents);
}

//  HUMAN CONTINUE / REVEAL / BREAK
// ─────────────────────────────────────────────────────────
function _handleContinue() {
  if (!_state || queueBusy()) return;

  let events = [];
  try {
    switch (_state.phase) {
      case 'REVEAL': events = revealPhase(_state); break;
      case 'BREAK':  events = semesterBreak(_state); break;
      case 'BREAK_DRAW':
        if (_state.breakDrawCurrent === _humanId) openBreakDrawOverlay();
        return;
      case 'PLAYING':
        if (_state.activePlayerId !== _humanId) _runAITurn(_state.activePlayerId);
        return;
      default: return;
    }
  } catch (err) {
    console.warn('[main] continue error:', err.message);
    return;
  }
  _dispatchEvents(events);
}

// ─────────────────────────────────────────────────────────
//  HUMAN DEADLINE ACTIONS
// ─────────────────────────────────────────────────────────
function _humanLetItRide() {
  if (!_state || queueBusy()) return;
  if (_state.phase !== 'DEADLINE') return;
  if (_state.projectLeaderId !== _humanId) return;
  let events;
  try { events = letItRide(_state); }
  catch (err) { console.warn(err.message); return; }
  _dispatchEvents(events);
}

function _humanUseSkill(choice) {
  if (!_state || queueBusy()) return;
  if (_state.phase !== 'DEADLINE') return;
  if (_state.projectLeaderId !== _humanId) return;
  let events;
  try { events = useLeadershipSkill(_state, choice); }
  catch (err) { console.warn(err.message); return; }

  // If Realign Priorities, open target picker overlay
  if (_state.pendingSkillStep === 'realign-pick-target') {
    _dispatchEvents(events);
    setTimeout(() => _openRealignOverlay(), _delay(200));
    return;
  }
  _dispatchEvents(events);
}

function _openRealignOverlay() {
  const targets = activePlayers(_state).filter(id => id !== _humanId);
  const overlay = _createOverlay('realign-overlay', 'Who should Realign Priorities target?',
    'Their top Party Pile card swaps with their Project Pile card.',
    targets,
    id => {
      overlay.remove();
      let events;
      try { events = completeRealignSkill(_state, id); }
      catch (err) { console.warn(err.message); return; }
      _dispatchEvents(events);
    }
  );
  document.body.appendChild(overlay);
}

// ─────────────────────────────────────────────────────────
//  EXTRA CREDIT PICK  (human leader chooses recipient)
// ─────────────────────────────────────────────────────────
function _openExtraCreditOverlay() {
  if (!_state || _state.pendingSkillStep !== 'extra-credit-pick') return;
  if (_state.projectLeaderId !== _humanId) return;

  // Remove any existing overlay
  const existing = document.getElementById('ec-overlay');
  if (existing) return;

  const options = activePlayers(_state).filter(id => id !== _humanId);
  const overlay = _createOverlay(
    'ec-overlay',
    'Award Extra Credit',
    'The project passed! You already earned Extra Credit. Choose one other player to also receive Extra Credit.',
    options,
    id => {
      overlay.remove();
      let events;
      try {
        events = awardLeaderExtraCredit(_state, { leaderId: _humanId, recipientId: id });
      } catch (err) { console.warn(err.message); return; }
      _dispatchEvents(events);
    }
  );
  document.body.appendChild(overlay);
}

// ─────────────────────────────────────────────────────────
//  HUMAN BLAME
// ─────────────────────────────────────────────────────────
function _openBlameOverlay() {
  if (!_state || queueBusy()) return;
  if (_state.phase !== 'BLAME') return;
  if (_state.projectLeaderId !== _humanId) return;

  const targets = activePlayers(_state).filter(id => id !== _humanId);
  const overlay = _createOverlay('blame-overlay', 'Who are you accusing?',
    'The group will vote. If they disagree, you take the fail instead.',
    targets,
    id => {
      overlay.remove();
      let events;
      try { events = accusePlayer(_state, { accuserId: _humanId, accusedId: id }); }
      catch (err) { console.warn(err.message); return; }
      if (_state.phase === 'BLAME_VOTE') {
        events.push(..._runAIVotingCascade());
      }
      _dispatchEvents(events);
    }
  );
  document.body.appendChild(overlay);
}


// ─────────────────────────────────────────────────────────
//  BLAME VOTE OVERLAY — card-image voting UI
// ─────────────────────────────────────────────────────────
function _openBlameVoteOverlay() {
  if (!_state || _state.phase !== 'BLAME_VOTE') return;
  if (!_state.blameVotersRemaining?.includes(_humanId)) return;
  if (document.getElementById('blame-vote-overlay')) return;  // already open

  const accused = _state.players[_state.blameAccusedId];
  const leader  = _state.players[_state.projectLeaderId];
  if (!accused || !leader) return;

  const accFails = totalFails(accused);
  const ldrFails = totalFails(leader);

  const overlay = document.createElement('div');
  overlay.id        = 'blame-vote-overlay';
  overlay.className = 'overlay-screen active';
  overlay.innerHTML = `
    <div class="overlay-sheet blame-vote-sheet">
      <div class="overlay-title">Who was really to blame?</div>
      <div class="overlay-body">
        Vote by clicking a card.<br>
        If the group disagrees with the Project Leader, the Leader takes the fail instead.
      </div>
      <div class="blame-vote-cards">
        <div class="blame-vote-card" id="bvo-leader" role="button" tabindex="0">
          <img src="./cards/blame-leader.jpg" alt="Blame the Project Leader" class="blame-vote-img">
          <div class="blame-vote-badge leader-badge">Project Leader</div>
          <div class="blame-vote-name">${_esc(leader.name)}</div>
          <div class="blame-vote-stats">${ldrFails} fail${ldrFails !== 1 ? 's' : ''} &bull; ${leader.extraCredits} EC</div>
        </div>
        <div class="blame-vote-card" id="bvo-accused" role="button" tabindex="0">
          <img src="./cards/blame-accused.jpg" alt="Blame the Accused" class="blame-vote-img">
          <div class="blame-vote-badge accused-badge">The Accused</div>
          <div class="blame-vote-name">${_esc(accused.name)}</div>
          <div class="blame-vote-stats">${accFails} fail${accFails !== 1 ? 's' : ''} &bull; ${accused.extraCredits} EC</div>
        </div>
      </div>
    </div>`;

  const doVote = (getTargetFn) => {
    overlay.remove();
    _humanVote(getTargetFn);
  };

  overlay.querySelector('#bvo-leader').addEventListener('click',  () => doVote(s => s.projectLeaderId));
  overlay.querySelector('#bvo-accused').addEventListener('click', () => doVote(s => s.blameAccusedId));

  // Also keep keyboard support
  overlay.querySelector('#bvo-leader').addEventListener('keydown',  e => { if (e.key === 'Enter' || e.key === ' ') doVote(s => s.projectLeaderId);  });
  overlay.querySelector('#bvo-accused').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') doVote(s => s.blameAccusedId); });

  document.body.appendChild(overlay);
}

// ─────────────────────────────────────────────────────────
//  HUMAN VOTING
// ─────────────────────────────────────────────────────────
function _humanVote(getTargetFn) {
  if (!_state || queueBusy()) return;
  if (_state.phase !== 'BLAME_VOTE') return;
  if (!_state.blameVotersRemaining.includes(_humanId)) return;
  const voteFor = getTargetFn(_state);
  let events;
  try { events = castVote(_state, { voterId: _humanId, voteFor }); }
  catch (err) { console.warn(err.message); return; }
  if (_state.phase === 'BLAME_VOTE') {
    events.push(..._runAIVotingCascade());
  }
  _dispatchEvents(events);
}

// ─────────────────────────────────────────────────────────
//  HUMAN SNITCH
// ─────────────────────────────────────────────────────────
function _openSnitchOverlay() {
  if (!_state || queueBusy()) return;
  if (_state.phase !== 'SNITCH') return;
  if (_state.snitchCurrentId !== _humanId) return;

  const alreadySnitched = _state.snitchedThisTurn || [];
  const targets = activePlayers(_state).filter(
    id => id !== _humanId && !alreadySnitched.includes(id)
  );
  // If no targets remain, auto-pass
  if (targets.length === 0) { _humanSnitchPass(); return; }
  const overlay = _createOverlay('snitch-overlay', 'Who are you snitching on?',
    'Their top Party Pile card will be revealed and compared to yours.',
    targets,
    id => {
      overlay.remove();
      let events;
      try { events = snitchTarget(_state, { snitcherId: _humanId, targetId: id }); }
      catch (err) { console.warn(err.message); return; }
      _dispatchEvents(events);
    }
  );
  document.body.appendChild(overlay);
}

function _humanSnitchPass() {
  if (!_state || queueBusy()) return;
  if (_state.phase !== 'SNITCH' || _state.snitchCurrentId !== _humanId) return;
  let events;
  try { events = snitchPass(_state); }
  catch (err) { console.warn(err.message); return; }
  _dispatchEvents(events);
}

// ─────────────────────────────────────────────────────────
//  SEMESTER BREAK DRAW
// ─────────────────────────────────────────────────────────
// Human's turn to draw a pair — opens a selector overlay
// Image and description for each pool pair key
const _PAIR_DISPLAY = {
  '0+8':    { imgA: './cards/effort/0.jpg',        imgB: './cards/effort/8.jpg',        altA: '0',        altB: '8',        label: '0 + 8 Effort' },
  'cram':   { imgA: './cards/effort/cram6.jpg',    imgB: './cards/effort/cram2.jpg',    altA: 'Cram 6',   altB: 'Cram 2',   label: 'Cram · +1 per Cram in pile' },
  'cheat':  { imgA: './cards/effort/cheat5.jpg',   imgB: './cards/effort/cheat5.jpg',   altA: 'Cheat 5',  altB: 'Cheat 5',  label: 'Cheat · −2 per other Cheat' },
  'colead': { imgA: './cards/effort/colead.jpg',   imgB: './cards/effort/colead.jpg',   altA: 'Co-Lead',  altB: 'Co-Lead',  label: 'Co-Lead · transfers on pass' },
  'copy':   { imgA: './cards/effort/Copy.jpg',     imgB: './cards/effort/Copy.jpg',     altA: 'X2 Copy',  altB: 'X2 Copy',  label: 'X2 Copy · doubles next card' },
};

export function openBreakDrawOverlay() {
  if (!_state || queueBusy()) return;
  if (_state.phase !== 'BREAK_DRAW') return;
  if (_state.breakDrawCurrent !== _humanId) return;

  const available = getAvailablePairKeys(_state);
  if (available.length === 0) { _advance(); return; }

  if (document.getElementById('break-draw-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id        = 'break-draw-overlay';
  overlay.className = 'overlay-screen active';

  const pairItems = available.map(key => {
    const d = _PAIR_DISPLAY[key] ?? { imgA: '', imgB: '', altA: key, altB: '', label: key };
    return `
      <div class="break-pair-option" data-key="${key}" role="button" tabindex="0">
        <div class="break-pair-cards">
          <img src="${d.imgA}" alt="${d.altA}" class="break-pair-card-img">
          <img src="${d.imgB}" alt="${d.altB}" class="break-pair-card-img">
        </div>
        <div class="break-pair-label">${d.label}</div>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="overlay-sheet break-draw-sheet">
      <div class="overlay-title">Semester Break — Draw a Pair</div>
      <div class="overlay-body">Click a pair to add both cards to your hand for the new semester.</div>
      <div class="break-pair-grid">${pairItems}</div>
    </div>`;

  const pick = (key) => {
    overlay.remove();
    let events;
    try { events = drawPair(_state, { playerId: _humanId, key }); }
    catch (err) { console.warn(err.message); return; }
    // Cascade remaining AI drawers
    while (_state.phase === 'BREAK_DRAW' && _state.breakDrawCurrent) {
      const nextP = _state.players[_state.breakDrawCurrent];
      if (!nextP || nextP.isHuman) break;
      const a = getAIAction(_state, _state.breakDrawCurrent);
      if (a?.type === 'DRAW_PAIR' && a.key) {
        events.push(...drawPair(_state, { playerId: _state.breakDrawCurrent, key: a.key }));
      } else break;
    }
    _dispatchEvents(events);
  };

  overlay.querySelectorAll('.break-pair-option').forEach(el => {
    el.addEventListener('click',   () => pick(el.dataset.key));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') pick(el.dataset.key); });
  });

  document.body.appendChild(overlay);
}

// ─────────────────────────────────────────────────────────
//  OVERLAY FACTORY
// ─────────────────────────────────────────────────────────
function _createOverlay(id, title, body, playerIds, onSelect) {
  const overlay = document.createElement('div');
  overlay.id        = id;
  overlay.className = 'overlay-screen active';
  overlay.innerHTML = `
    <div class="overlay-sheet">
      <div class="overlay-title">${_esc(title)}</div>
      <div class="overlay-body">${_esc(body)}</div>
      <div class="overlay-actions" id="${id}-targets"></div>
      <button class="btn-t" id="${id}-cancel">Cancel</button>
    </div>`;

  const targetsEl = overlay.querySelector(`#${id}-targets`);
  for (const pid of playerIds) {
    const p   = _state.players[pid];
    const btn = document.createElement('button');
    btn.className   = 'btn-danger';
    btn.textContent = p.name;
    btn.addEventListener('click', () => onSelect(pid));
    targetsEl.appendChild(btn);
  }

  overlay.querySelector(`#${id}-cancel`).addEventListener('click', () => overlay.remove());
  return overlay;
}

function _esc(str) {
  return String(str ?? '').replace(/[<>&"]/g, c =>
    ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c])
  );
}

// ─────────────────────────────────────────────────────────
//  SIMPLE MODE OVERLAYS
// ─────────────────────────────────────────────────────────

function _openSlackerVoteOverlay() {
  if (!_state || _state.phase !== 'GROUP_EVAL') return;
  if (document.getElementById('slacker-vote-overlay')) return;

  const active = activePlayers(_state).filter(id => id !== _humanId);
  const overlay = document.createElement('div');
  overlay.id = 'slacker-vote-overlay';
  overlay.className = 'overlay-screen active';

  overlay.innerHTML = `
    <div class="overlay-sheet slacker-vote-sheet">
      <div class="overlay-title">Group Evaluation</div>
      <div class="slacker-vote-intro">The project passed — who slacked off?</div>
      <div class="slacker-vote-grid" id="sv-grid"></div>
    </div>`;

  const grid = overlay.querySelector('#sv-grid');
  for (const pid of active) {
    const p   = _state.players[pid];
    const btn = document.createElement('div');
    btn.className    = 'slacker-vote-card';
    btn.dataset.pid  = pid;
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = `
      <img src="./cards/slacker.jpg" alt="Slacker card" class="slacker-vote-img"/>
      <div class="slacker-vote-name">${_esc(p.name)}</div>
      <div class="slacker-vote-stats">${totalFails(p)} fail${totalFails(p) !== 1 ? 's' : ''}</div>`;

    const vote = () => {
      overlay.remove();
      try {
        const events = castSlackerVote(_state, _humanId, pid);
        // Now cascade all remaining AI votes
        while (_state.phase === 'GROUP_EVAL' && _state.evalVotersRemaining?.length > 0) {
          const nextId = _state.evalVotersRemaining[0];
          const nextP  = _state.players[nextId];
          if (!nextP || nextP.isHuman) break;
          const action = getAIAction(_state, nextId);
          if (action?.type === 'SLACKER_VOTE') {
            events.push(...castSlackerVote(_state, nextId, action.targetId));
          } else { break; }
        }
        _dispatchEvents(events);
      } catch (e) { console.warn(e); }
    };
    btn.addEventListener('click', vote);
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') vote(); });
    grid.appendChild(btn);
  }

  document.body.appendChild(overlay);
}

function _openTieBreakOverlay() {
  if (!_state || _state.phase !== 'GROUP_EVAL_LEADER_TIE') return;
  if (document.getElementById('tie-break-overlay')) return;

  const tied = _state.evalTiedPlayers ?? [];
  const overlay = document.createElement('div');
  overlay.id = 'tie-break-overlay';
  overlay.className = 'overlay-screen active';
  overlay.innerHTML = `
    <div class="overlay-sheet slacker-vote-sheet">
      <div class="overlay-title">Tie Break</div>
      <div class="slacker-vote-intro">Tied vote! As Project Leader, move one Slacker card to:</div>
      <div class="slacker-vote-grid" id="tb-grid"></div>
    </div>`;

  const grid = overlay.querySelector('#tb-grid');
  for (const pid of tied) {
    const p   = _state.players[pid];
    const btn = document.createElement('div');
    btn.className = 'slacker-vote-card';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = `
      <img src="./cards/slacker.jpg" alt="Slacker card" class="slacker-vote-img"/>
      <div class="slacker-vote-name">${_esc(p.name)}</div>
      <div class="slacker-vote-stats">${_state.evalRoundCounts[pid] ?? 0} slacker cards</div>`;

    const pick = () => {
      overlay.remove();
      const toId   = pid;
      const fromId = tied.find(id => id !== toId) ?? toId;
      try { _dispatchEvents(leaderBreakTie(_state, fromId, toId)); }
      catch (e) { console.warn(e); }
    };
    btn.addEventListener('click', pick);
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') pick(); });
    grid.appendChild(btn);
  }
  document.body.appendChild(overlay);
}

// ── "Who's to Blame?" vote overlay (after a FAIL) ─────────
function _openFailBlameVoteOverlay() {
  if (!_state || _state.phase !== 'SIMPLE_BLAME_VOTE') return;
  if (document.getElementById('fail-blame-vote-overlay')) return;

  const active  = activePlayers(_state).filter(id => id !== _humanId);
  const overlay = document.createElement('div');
  overlay.id = 'fail-blame-vote-overlay';
  overlay.className = 'overlay-screen active';

  overlay.innerHTML = `
    <div class="overlay-sheet slacker-vote-sheet">
      <div class="overlay-title">Who Is To Blame?</div>
      <div class="slacker-vote-intro">The project FAILED — vote on who's to blame.</div>
      <div class="slacker-vote-grid" id="fbv-grid"></div>
    </div>`;

  const grid = overlay.querySelector('#fbv-grid');
  for (const pid of active) {
    const p   = _state.players[pid];
    const btn = document.createElement('div');
    btn.className   = 'slacker-vote-card';
    btn.dataset.pid = pid;
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = `
      <img src="./cards/other/Fail1.jpg" alt="Fail card" class="slacker-vote-img"/>
      <div class="slacker-vote-name">${_esc(p.name)}</div>
      <div class="slacker-vote-stats">${totalFails(p)} fail${totalFails(p) !== 1 ? 's' : ''}</div>`;

    const vote = () => {
      overlay.remove();
      try {
        const events = castFailBlameVote(_state, _humanId, pid);
        while (_state.phase === 'SIMPLE_BLAME_VOTE' && _state.failVoteVotersRemaining?.length > 0) {
          const nextId = _state.failVoteVotersRemaining[0];
          const nextP  = _state.players[nextId];
          if (!nextP || nextP.isHuman) break;
          const action = getAIAction(_state, nextId);
          if (action?.type === 'FAIL_BLAME_VOTE') {
            events.push(...castFailBlameVote(_state, nextId, action.targetId));
          } else { break; }
        }
        _dispatchEvents(events);
      } catch (e) { console.warn(e); }
    };
    btn.addEventListener('click', vote);
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') vote(); });
    grid.appendChild(btn);
  }

  document.body.appendChild(overlay);
}

// ── Leader breaks a "who's to blame" tie ──────────────────
function _openFailTieBreakOverlay() {
  if (!_state || _state.phase !== 'SIMPLE_BLAME_LEADER_TIE') return;
  if (document.getElementById('fail-tie-break-overlay')) return;

  const tied = _state.failTiedPlayers ?? [];
  const overlay = document.createElement('div');
  overlay.id = 'fail-tie-break-overlay';
  overlay.className = 'overlay-screen active';
  overlay.innerHTML = `
    <div class="overlay-sheet slacker-vote-sheet">
      <div class="overlay-title">Tie Break</div>
      <div class="slacker-vote-intro">Tied vote! As Project Leader, move one Fail card to:</div>
      <div class="slacker-vote-grid" id="ftb-grid"></div>
    </div>`;

  const grid = overlay.querySelector('#ftb-grid');
  for (const pid of tied) {
    const p   = _state.players[pid];
    const btn = document.createElement('div');
    btn.className = 'slacker-vote-card';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = `
      <img src="./cards/other/Fail1.jpg" alt="Fail card" class="slacker-vote-img"/>
      <div class="slacker-vote-name">${_esc(p.name)}</div>
      <div class="slacker-vote-stats">${_state.failRoundCounts[pid] ?? 0} fail votes</div>`;

    const pick = () => {
      overlay.remove();
      const toId   = pid;
      const fromId = tied.find(id => id !== toId) ?? toId;
      try { _dispatchEvents(leaderBreakFailTie(_state, fromId, toId)); }
      catch (e) { console.warn(e); }
    };
    btn.addEventListener('click', pick);
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') pick(); });
    grid.appendChild(btn);
  }
  document.body.appendChild(overlay);
}

// ── Snitch chain — current snitcher names a target ────────
function _openSimpleSnitchOverlay() {
  if (!_state || _state.phase !== 'SIMPLE_SNITCH') return;
  if (_state.simpleSnitchCurrentId !== _humanId) return;
  if (document.getElementById('simple-snitch-overlay')) return;

  const targets = activePlayers(_state).filter(id => id !== _humanId);
  if (targets.length === 0) return;   // shouldn't happen with >=2 active players

  const overlay = document.createElement('div');
  overlay.id = 'simple-snitch-overlay';
  overlay.className = 'overlay-screen active';
  overlay.innerHTML = `
    <div class="overlay-sheet slacker-vote-sheet">
      <div class="overlay-title">You Must Snitch</div>
      <div class="slacker-vote-intro">
        Name a player to reveal their top Party Pile card. If it's higher
        than yours, you drop the Fail (but still bank a Slacker card).
        Otherwise you keep the Fail AND bank a Slacker card.
      </div>
      <div class="slacker-vote-grid" id="ss-grid"></div>
    </div>`;

  const grid = overlay.querySelector('#ss-grid');
  for (const pid of targets) {
    const p   = _state.players[pid];
    const btn = document.createElement('div');
    btn.className = 'slacker-vote-card';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = `<div class="slacker-vote-name">${_esc(p.name)}</div>`;

    const snitch = () => {
      overlay.remove();
      try { _dispatchEvents(simpleSnitchTarget(_state, _humanId, pid)); }
      catch (e) { console.warn(e); }
    };
    btn.addEventListener('click', snitch);
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') snitch(); });
    grid.appendChild(btn);
  }
  document.body.appendChild(overlay);
}

// ─────────────────────────────────────────────────────────
//  EVENT DISPATCH
// ─────────────────────────────────────────────────────────
function _dispatchEvents(events) {
  if (!events || events.length === 0) return;
  const steps = buildStepsFromEvents(events, _state);
  enqueueAll(steps);
  runQueue();

  // Handle BREAK_DRAW after queue drains (we need the human to see the UI)
  // openBreakDrawOverlay is called from renderer after SEMESTER_BREAK_START
}

// ─────────────────────────────────────────────────────────
//  SCREEN MANAGEMENT
// ─────────────────────────────────────────────────────────
function _goScoreboard() {
  if (!_state) return;
  renderScoreboard(_state);
  _goScreen('score');
}

function _goScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('s-' + id);
  if (el) { el.classList.add('active'); el.scrollTop = 0; }
}

// ─────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────
function _on(id, handler) {
  const el = document.getElementById(id);
  if (!el) return;
  el.removeAttribute('onclick');
  el.addEventListener('click', handler);
}

function _showAIThinking(name) {
  const el = document.getElementById('ai-thinking');
  if (!el) return;
  const safe = String(name || '').replace(/[<>&"]/g, c =>
    ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c])
  );
  el.innerHTML =
    (safe ? `${safe}&thinsp;` : '') +
    `thinking<span></span><span></span><span></span>`;
  el.style.display = '';
}

function _hideAIThinking() {
  const el = document.getElementById('ai-thinking');
  if (el) el.style.display = 'none';
}

window.__slk = { startGame, openBreakDrawOverlay, setDifficulty(d) { _lobbyDifficulty = d; } };
