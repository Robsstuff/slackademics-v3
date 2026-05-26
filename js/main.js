/* =====================================================
   SLACKADEMICS — Main Entry Point (Rulebook v2)
   ===================================================== */
'use strict';

import { createState }               from './state.js';
import {
  playPair, revealPhase, letItRide, useLeadershipSkill,
  completeRealignSkill, accusePlayer, castVote, skipBlame,
  snitchTarget, snitchPass, semesterBreak, drawPair,
  awardLeaderExtraCredit,
  getValidActions, activePlayers, getAvailablePairKeys,
}                                     from './engine.js';
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
export function startGame(lobbyPlayers) {
  const configs = lobbyPlayers.map((p, i) => ({
    id:      'p' + (i + 1),
    name:    p.name,
    isHuman: !!p.isHuman,
    aiMode:  p.aiMode || 'regular',
  }));

  _humanId = configs.find(c => c.isHuman)?.id ?? configs[0].id;
  // Also read window._slk_diff in case setDifficulty was called before __slk was ready
  if (window._slk_diff != null) _lobbyDifficulty = window._slk_diff;
  _state   = createState(configs, _lobbyDifficulty);
  _stagedProject = null;
  _stagedParty   = null;

  queueSetHuman(_humanId);
  queueSetOnDone(_afterQueueDrain);
  setCardClickCallback(_onHumanCardClick);

  const logList = document.getElementById('log-list');
  if (logList) { logList.innerHTML = ''; logList.dataset.logCount = '0'; }

  renderAll(_state, _humanId);
  _goScreen('game');
  setTimeout(() => _advance(), 400);
}

// ─────────────────────────────────────────────────────────
//  GAME LOOP
// ─────────────────────────────────────────────────────────
function _advance() {
  if (!_state || queueBusy()) return;

  const phase = _state.phase;

  switch (phase) {
    case 'GAMEOVER':
      setTimeout(_goScoreboard, 1200);
      return;

    case 'REVEAL': {
      // Auto-reveal after a short pause so players can see the pile
      setTimeout(() => _dispatchEvents(revealPhase(_state)), 900);
      return;
    }

    case 'BREAK': {
      // If extra credit pick is pending, open overlay for human leader or auto for AI
      if (_state.pendingSkillStep === 'extra-credit-pick') {
        const leaderId = _state.projectLeaderId;
        const leader   = _state.players[leaderId];
        if (leader && !leader.isExpelled) {
          if (leader.isHuman) {
            setTimeout(() => _openExtraCreditOverlay(), 300);
          } else {
            const action = getAIAction(_state, leaderId);
            if (action?.type === 'AWARD_EXTRA_CREDIT') {
              setTimeout(() => {
                try {
                  _dispatchEvents(awardLeaderExtraCredit(_state, {
                    leaderId, recipientId: action.recipientId,
                  }));
                } catch (e) { console.warn(e); }
              }, AI_THINK_DELAY);
            }
          }
        }
        return;
      }
      const human = _humanId ? _state.players[_humanId] : null;
      if (human && !human.isExpelled) return;   // human clicks Continue
      setTimeout(() => _dispatchEvents(semesterBreak(_state)), AI_THINK_DELAY);
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
  const playDelay = _state.phase === 'PLAYING' ? 0 : AI_THINK_DELAY;
  setTimeout(() => _runAITurn(activeId), playDelay);
}

function _afterQueueDrain() {
  _hideAIThinking();
  _advance();
}

// ─────────────────────────────────────────────────────────
//  AI TURNS
// ─────────────────────────────────────────────────────────
async function _runAITurn(playerId) {
  if (!_state || queueBusy()) return;

  const aiPlayer = _state.players[playerId];
  _showAIThinking(aiPlayer?.name ?? '');

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
    setTimeout(() => _openRealignOverlay(), 200);
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
export function openBreakDrawOverlay() {
  if (!_state || queueBusy()) return;
  if (_state.phase !== 'BREAK_DRAW') return;
  if (_state.breakDrawCurrent !== _humanId) return;

  const available = getAvailablePairKeys(_state, _humanId);
  if (available.length === 0) {
    // Auto-advance if nothing available
    _advance();
    return;
  }

  const existingOverlay = document.getElementById('break-draw-overlay');
  if (existingOverlay) return;

  const overlay = document.createElement('div');
  overlay.id        = 'break-draw-overlay';
  overlay.className = 'overlay-screen active';

  const labels = {
    '0+8':'0 + 8', '1+7':'1 + 7', '2+6':'2 + 6',
    '3+5':'3 + 5', '4+4':'4 + 4', 'copy+copy':'Copy + Copy',
  };

  let btns = available.map(key =>
    `<button class="btn-p break-pair-btn" data-key="${key}">${labels[key] ?? key}</button>`
  ).join('');

  overlay.innerHTML = `
    <div class="overlay-sheet">
      <div class="overlay-title">Draw a New Pair</div>
      <div class="overlay-body">Choose one pair to add to your hand. You cannot pick the same pair twice.</div>
      <div class="overlay-actions">${btns}</div>
    </div>`;

  overlay.querySelectorAll('.break-pair-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.remove();
      const key = btn.dataset.key;
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
    });
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
