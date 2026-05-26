/* =====================================================
   SLACKADEMICS — AI Module (Rulebook v2)
   Pair-based card selection + new phase handling.

   Entry point:
     getAIAction(state, playerId) → { type, ...params }

   Action types:
     { type:'PLAY_PAIR',        projectCardId, partyCardId }
     { type:'REVEAL' }
     { type:'LET_IT_RIDE' }
     { type:'USE_SKILL',        skillChoice }   // 'faceup'|'facedown'
     { type:'PICK_REALIGN_TARGET', targetId }
     { type:'ACCUSE',           accusedId }
     { type:'SKIP_BLAME' }
     { type:'CAST_VOTE',        voteFor }
     { type:'SNITCH_TARGET',    targetId }
     { type:'SNITCH_PASS' }
     { type:'NEXT_SEMESTER' }
     { type:'DRAW_PAIR',        key }
     { type:'VIEW_SCORES' }
   ===================================================== */
'use strict';

import { pick }                                         from './utils.js';
import { activePlayers, getAvailablePairKeys, isValidPair, computePileTotal }
                                                        from './engine.js';
import { pairKey, totalFails }                          from './state.js';

// ── Public entry point ────────────────────────────────────
export function getAIAction(state, playerId) {
  const player = state.players[playerId];
  if (!player || player.isExpelled) return null;

  switch (state.phase) {
    case 'PLAYING':    return _actionPlaying(state, playerId, player);
    case 'REVEAL':     return { type: 'REVEAL' };
    case 'DEADLINE':
      if (state.pendingSkillStep === 'realign-pick-target')
        return _actionRealignTarget(state, playerId, player);
      if (state.pendingSkillStep === 'extra-credit-pick' && state.projectLeaderId === playerId)
        return _actionPickExtraCredit(state, playerId, player);
      if (state.activePlayerId === playerId)
        return _actionDeadline(state, playerId, player);
      return null;
    case 'BLAME':
      if (state.projectLeaderId !== playerId) return null;
      return _actionBlame(state, playerId, player);
    case 'BLAME_VOTE':
      if (!state.blameVotersRemaining.includes(playerId)) return null;
      return _actionVote(state, playerId, player);
    case 'SNITCH':
      if (state.snitchCurrentId !== playerId) return null;
      return _actionSnitch(state, playerId, player);
    case 'BREAK':
      if (state.pendingSkillStep === 'extra-credit-pick' && state.projectLeaderId === playerId)
        return _actionPickExtraCredit(state, playerId, player);
      return { type: 'NEXT_SEMESTER' };
    case 'BREAK_DRAW':
      if (state.breakDrawCurrent !== playerId) return null;
      return _actionDrawPair(state, playerId, player);
    case 'GAMEOVER':   return { type: 'VIEW_SCORES' };
    default:           return null;
  }
}

// ─────────────────────────────────────────────────────────
//  PLAYING PHASE — pair selection
// ─────────────────────────────────────────────────────────

function _actionPlaying(state, playerId, player) {
  const hand = player.hand;
  if (hand.length < 2) return null;

  // Find all valid pairs from hand
  const pairs = _findAllPairs(hand);
  if (pairs.length === 0) return null;

  // Universal Copy-pair pre-check (20% chance) — skip for play_to_win which has its own copy logic
  const copyPairs = pairs.filter(([a, b]) => a.type === 'copy' && b.type === 'copy');
  if (player.aiMode !== 'play_to_win' && copyPairs.length > 0 && Math.random() < 0.20) {
    const [c1, c2] = copyPairs[0];
    return { type: 'PLAY_PAIR', projectCardId: c1.id, partyCardId: c2.id };
  }

  // Choose pair and split based on mode
  const { projectCard, partyCard } = _choosePair(state, playerId, player, pairs);
  if (!projectCard || !partyCard) {
    const [a, b] = pairs[0];
    return { type: 'PLAY_PAIR', projectCardId: a.id, partyCardId: b.id };
  }
  return { type: 'PLAY_PAIR', projectCardId: projectCard.id, partyCardId: partyCard.id };
}

// Returns all valid [cardA, cardB] pairs from hand
function _findAllPairs(hand) {
  const pairs = [];
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      if (isValidPair(hand[i], hand[j])) pairs.push([hand[i], hand[j]]);
    }
  }
  return pairs;
}

// Split a chosen pair into (projectCard, partyCard) per mode
function _choosePair(state, playerId, player, pairs) {
  const mode = player.aiMode;

  // Calculate average effort needed (for modes that use it)
  const active        = activePlayers(state);
  const yetToPlay     = active.filter(id => !state.players[id].playedPair).length;
  const currentTotal  = state.projectPile.reduce((s, c) => c.type === 'effort' ? s + c.value : s, 0);
  const effortNeeded  = state.projectTarget - currentTotal;
  const avg           = yetToPlay > 0 ? effortNeeded / yetToPlay : 4;

  switch (mode) {

    // ── GREEDY: maximise party pile ───────────────────────
    case 'greedy': {
      // Pick a random pair, use probabilistic split
      const [c1, c2] = pick(pairs);
      const lo = c1.value <= c2.value ? c1 : c2;
      const hi = c1.value <= c2.value ? c2 : c1;
      if (lo.type === 'copy' || hi.type === 'copy') {
        return { projectCard: c1, partyCard: c2 };
      }
      // P(play High to Project) = lo/hi
      const prob = hi.value > 0 ? lo.value / hi.value : 0.5;
      if (Math.random() < prob) {
        return { projectCard: hi, partyCard: lo };
      }
      return { projectCard: lo, partyCard: hi };
    }

    // ── NICE: contribute above average ───────────────────
    case 'nice': {
      // Pick pair with effort card ≥ avg for project; fallback to highest
      const qualifying = pairs.filter(([a, b]) => {
        const aVal = a.type === 'effort' ? a.value : 0;
        const bVal = b.type === 'effort' ? b.value : 0;
        return Math.max(aVal, bVal) >= avg;
      });
      const [c1, c2] = qualifying.length > 0 ? pick(qualifying) : pick(pairs);
      // Higher value → project
      const projCard = (c1.type === 'effort' && c2.type === 'effort')
        ? (c1.value >= c2.value ? c1 : c2)
        : (c1.type === 'effort' ? c1 : c2);
      const partCard = projCard === c1 ? c2 : c1;
      return { projectCard: projCard, partyCard: partCard };
    }

    // ── ASSHOLE: play lowest to project ──────────────────
    case 'asshole': {
      const roll = Math.random() * 100;
      // Sort all effort cards ascending across all pairs
      const effortPairs = pairs.filter(([a, b]) => a.type === 'effort' && b.type === 'effort');
      if (effortPairs.length === 0) return { projectCard: pairs[0][0], partyCard: pairs[0][1] };

      // Flatten to get globally sorted effort cards
      const allEffort = [...new Set(effortPairs.flat())].sort((a, b) => a.value - b.value);
      let targetCard;
      if (roll < 70) {
        targetCard = allEffort[0];  // globally lowest
      } else {
        targetCard = allEffort.length > 1 ? allEffort[1] : allEffort[0];  // 2nd lowest
      }
      // Find a valid pair containing targetCard
      const validPair = effortPairs.find(([a, b]) => a.id === targetCard.id || b.id === targetCard.id);
      if (!validPair) return { projectCard: pairs[0][0], partyCard: pairs[0][1] };
      const [pa, pb] = validPair;
      const projCard = pa.id === targetCard.id ? pa : pb;
      const partCard = pa.id === targetCard.id ? pb : pa;
      return { projectCard: projCard, partyCard: partCard };
    }

    // ── REGULAR: close to average ─────────────────────────
    case 'regular': {
      const roll = Math.random() * 100;
      const effortPairs = pairs.filter(([a, b]) => a.type === 'effort' && b.type === 'effort');
      if (effortPairs.length === 0) return { projectCard: pairs[0][0], partyCard: pairs[0][1] };

      // Get all effort cards across valid pairs, sorted by distance from avg
      const allEffort = [...new Set(effortPairs.flat())].sort((a, b) =>
        Math.abs(a.value - avg) - Math.abs(b.value - avg)
      );

      let chosen;
      if (roll <= 50) {
        chosen = allEffort[0];  // closest to avg
      } else if (roll <= 70) {
        chosen = allEffort.find(c => c.value > avg) ?? allEffort[0];  // one step above
      } else if (roll <= 80) {
        chosen = allEffort.find(c => c.value < avg) ?? allEffort[0];  // one step below
      } else {
        chosen = allEffort[0];  // fallback closest
      }

      const validPair = effortPairs.find(([a, b]) => a.id === chosen.id || b.id === chosen.id);
      if (!validPair) return { projectCard: pairs[0][0], partyCard: pairs[0][1] };
      const [pa, pb] = validPair;
      const projCard = pa.id === chosen.id ? pa : pb;
      const partCard = pa.id === chosen.id ? pb : pa;
      return { projectCard: projCard, partyCard: partCard };
    }

    // ── RANDOM: pure coin flip ────────────────────────────
    case 'random': {
      const [c1, c2] = pick(pairs);
      return Math.random() < 0.5
        ? { projectCard: c1, partyCard: c2 }
        : { projectCard: c2, partyCard: c1 };
    }

    // ── SNEAKY: 70% regular / 30% asshole ────────────────
    case 'sneaky': {
      const subMode = Math.random() < 0.70 ? 'regular' : 'asshole';
      return _choosePair(state, playerId, { ...player, aiMode: subMode }, pairs);
    }

    // ── GTO: state-adjusted mixed ─────────────────────────
    case 'gto': {
      const roll = Math.random() * 100;
      const effortPairs = pairs.filter(([a, b]) => a.type === 'effort' && b.type === 'effort');
      if (effortPairs.length === 0) return { projectCard: pairs[0][0], partyCard: pairs[0][1] };

      const myFails   = totalFails(player);
      const myParty   = computePileTotal(player.partyPile);
      const maxParty  = Math.max(...activePlayers(state).map(id => computePileTotal(state.players[id].partyPile)));

      // Adjust roll thresholds based on game state
      let closestT = 35, aboveT = 55, belowT = 70, highT = 80;
      if (myFails >= 3) { aboveT = 65; closestT = 45; }         // need to contribute more
      if (myParty >= maxParty) { belowT = 60; aboveT = 50; }    // protect lead

      const allEffort = [...new Set(effortPairs.flat())].sort((a, b) =>
        Math.abs(a.value - avg) - Math.abs(b.value - avg)
      );
      const highest = allEffort.reduce((m, c) => c.value > m.value ? c : m, allEffort[0]);

      let chosen;
      if (roll <= closestT) {
        chosen = allEffort[0];
      } else if (roll <= aboveT) {
        chosen = allEffort.find(c => c.value > avg) ?? allEffort[0];
      } else if (roll <= belowT) {
        chosen = allEffort.find(c => c.value < avg) ?? allEffort[0];
      } else if (roll <= highT) {
        chosen = highest;
      } else {
        chosen = allEffort[0];
      }

      const validPair = effortPairs.find(([a, b]) => a.id === chosen.id || b.id === chosen.id);
      if (!validPair) return { projectCard: pairs[0][0], partyCard: pairs[0][1] };
      const [pa, pb] = validPair;
      return { projectCard: pa.id === chosen.id ? pa : pb, partyCard: pa.id === chosen.id ? pb : pa };
    }

    // ── PLAY TO WIN: probability-based optimiser ─────────
    case 'play_to_win': {
      const myFails    = totalFails(player);
      const effortPairs = pairs.filter(([a, b]) => a.type === 'effort' && b.type === 'effort');

      // Helper: play a chosen card to project, its pair partner to party
      const splitOn = (chosen, pairList) => {
        const vp = pairList.find(([a, b]) => a.id === chosen.id || b.id === chosen.id);
        if (!vp) return { projectCard: pairs[0][0], partyCard: pairs[0][1] };
        const [pa, pb] = vp;
        return { projectCard: pa.id === chosen.id ? pa : pb, partyCard: pa.id === chosen.id ? pb : pa };
      };

      // 4-fail override: must contribute ≥ avg to avoid expulsion risk
      if (myFails >= 4) {
        const qualifying = effortPairs.length > 0
          ? effortPairs.filter(([a, b]) => Math.max(a.value, b.value) >= avg)
          : pairs.filter(([a, b]) => {
            const aVal = a.type === 'effort' ? a.value : 0;
            const bVal = b.type === 'effort' ? b.value : 0;
            return Math.max(aVal, bVal) >= avg;
          });
        const [c1, c2] = qualifying.length > 0 ? pick(qualifying) : pick(pairs);
        const hi = (c1.type === 'effort' && c2.type === 'effort')
          ? (c1.value >= c2.value ? c1 : c2)
          : (c1.type === 'effort' ? c1 : c2);
        return { projectCard: hi, partyCard: hi === c1 ? c2 : c1 };
      }

      // Post-copy turn: 70% greedy (lowest to project = keep highest for party)
      if (player._ptwPlayedCopy) {
        player._ptwPlayedCopy = false;
        if (Math.random() < 0.70 && effortPairs.length > 0) {
          const allEffort = effortPairs.flat().sort((a, b) => a.value - b.value);
          const lo = allEffort[0];
          return splitOn(lo, effortPairs);
        }
      }

      // 25% chance to play copy pair if available
      if (copyPairs.length > 0 && Math.random() < 0.25) {
        player._ptwPlayedCopy = true;
        const [c1, c2] = copyPairs[0];
        return { projectCard: c1, partyCard: c2 };
      }

      if (effortPairs.length === 0) {
        return { projectCard: pairs[0][0], partyCard: pairs[0][1] };
      }

      const allEffort = effortPairs.flat().sort((a, b) => a.value - b.value);
      const roll = Math.random() * 100;

      if (roll < 15) {
        // 15%: play lowest to project (maximise party pile)
        return splitOn(allEffort[0], effortPairs);
      } else if (roll < 25) {
        // 10%: play above-avg to project
        const aboveAvg = allEffort.filter(c => c.value > avg);
        const chosen   = aboveAvg.length > 0 ? pick(aboveAvg) : allEffort[allEffort.length - 1];
        return splitOn(chosen, effortPairs);
      } else {
        // 75%: play at/below-avg to project
        const atBelow = allEffort.filter(c => c.value <= avg);
        const chosen  = atBelow.length > 0 ? pick(atBelow) : allEffort[0];
        return splitOn(chosen, effortPairs);
      }
    }

    default: {
      const [c1, c2] = pairs[0];
      return { projectCard: c1, partyCard: c2 };
    }
  }
}

// ─────────────────────────────────────────────────────────
//  DEADLINE PHASE
// ─────────────────────────────────────────────────────────

function _actionDeadline(state, playerId, player) {
  const revealedTotal = computePileTotal(state.projectPile.filter(c => c.revealed));
  // Estimate the unknown last card value
  const playedEffort = state.projectPile.filter(c => c.revealed && c.type === 'effort');
  const unknownCount = state.projectPile.filter(c => !c.revealed).length;
  const avgCardVal   = 4;  // fallback estimate

  const estimatedTotal = revealedTotal + unknownCount * avgCardVal;
  const target = state.projectTarget + (state.targetBonus || 0);

  // If estimated to pass anyway, Let It Ride
  if (estimatedTotal >= target) return { type: 'LET_IT_RIDE' };

  // If a skill can help, use it
  const gap = target - revealedTotal;

  // Check if face-up skill looks useful
  if (state.faceUpSkill) {
    const bonus = _estimateSkillBonus(state, state.faceUpSkill, false);
    if (revealedTotal + bonus + avgCardVal >= target) {
      return { type: 'USE_SKILL', skillChoice: 'faceup' };
    }
  }

  // Try face-down skill (unknown bonus — use 30% of the time when behind)
  if (state.faceDownSkill && gap > 3) {
    if (Math.random() < 0.40) return { type: 'USE_SKILL', skillChoice: 'facedown' };
  }

  return { type: 'LET_IT_RIDE' };
}

function _estimateSkillBonus(state, skill, wasFaceDown) {
  const pile = state.projectPile;
  switch (skill.id) {
    case 'diversity': {
      const u = new Set(pile.filter(c => c.type === 'effort').map(c => c.value));
      return u.size;
    }
    case 'allnighter': return 4;   // rough estimate
    case 'coffee': return pile.filter(c => c.type === 'effort' && c.value <= 3).length * 2;
    case 'vibe': return 4;         // assume at least one pair
    case 'eureka': return 5;
    case 'desperation': return (state.projectsFailed || 0) * 1;
    case 'curve': return 6;
    case 'complain': return 8 - 4; // removes ~2 × avg 2 = 4, adds 8 → net +4
    case 'evenodds': return 2;
    case 'reputation': return Object.values(state.players).reduce((s, p) => s + p.extraCredits, 0) * 1;
    default: return 2;
  }
}

function _actionRealignTarget(state, playerId, player) {
  // Pick the player whose swap gives best benefit (highest party card)
  const targets = activePlayers(state).filter(id => id !== playerId);
  let bestId = targets[0];
  let bestVal = -1;
  for (const id of targets) {
    const partyTop = state.players[id].partyPile[state.players[id].partyPile.length - 1];
    if (partyTop && partyTop.type === 'effort' && partyTop.value > bestVal) {
      bestVal = partyTop.value;
      bestId  = id;
    }
  }
  return { type: 'PICK_REALIGN_TARGET', targetId: bestId };
}

function _actionPickExtraCredit(state, playerId, player) {
  // Pick the player with the lowest party pile score (help them out, or pick anyone)
  const options = activePlayers(state).filter(id => id !== playerId);
  if (options.length === 0) return { type: 'AWARD_EXTRA_CREDIT', recipientId: playerId };
  // Prefer player with fewest extra credits (generosity strategy)
  let pick = options[0];
  let minEC = Infinity;
  for (const id of options) {
    const ec = state.players[id].extraCredits;
    if (ec < minEC) { minEC = ec; pick = id; }
  }
  return { type: 'AWARD_EXTRA_CREDIT', recipientId: pick };
}

// ─────────────────────────────────────────────────────────
//  BLAME PHASE
// ─────────────────────────────────────────────────────────

function _actionBlame(state, playerId, player) {
  const targets = activePlayers(state).filter(id => id !== playerId);
  if (targets.length === 0) return { type: 'SKIP_BLAME' };

  // Update suspicion scores from revealed project cards
  _updateSuspicion(state, playerId, player);

  const roll = Math.random() * 100;

  if (roll > 70) {
    // Personality logic
    switch (_getPersonality(player.aiMode)) {
      case 'vindictive': {
        const retarget = player.blamedByHistory.find(id => targets.includes(id));
        if (retarget) return { type: 'ACCUSE', accusedId: retarget };
        break;
      }
      case 'fail-targeter': {
        const target = targets.reduce((m, id) => totalFails(state.players[id]) > totalFails(state.players[m]) ? id : m, targets[0]);
        return { type: 'ACCUSE', accusedId: target };
      }
      case 'winner-targeter': {
        const target = targets.reduce((m, id) => computePileTotal(state.players[id].partyPile) > computePileTotal(state.players[m].partyPile) ? id : m, targets[0]);
        return { type: 'ACCUSE', accusedId: target };
      }
    }
  }

  // Main logic: highest suspicion score
  const accused = targets.reduce((m, id) => {
    const s1 = player.suspicionScores[m]  ?? 0;
    const s2 = player.suspicionScores[id] ?? 0;
    return s2 > s1 ? id : m;
  }, targets[0]);

  return { type: 'ACCUSE', accusedId: accused };
}

function _updateSuspicion(state, playerId, player) {
  for (const card of state.projectPile) {
    if (!card.revealed || !card.playerId) continue;
    const tid = card.playerId;
    if (tid === playerId) continue;
    const inferred = card.type === 'effort' ? Math.max(0, 8 - card.value) : 0;
    player.suspicionScores[tid] = (player.suspicionScores[tid] ?? 0) + inferred;
  }
}

function _getPersonality(aiMode) {
  const map = { gto:'vindictive', greedy:'winner-targeter', asshole:'fail-targeter', nice:'fail-targeter', regular:'vindictive', sneaky:'winner-targeter', random:'vindictive' };
  return map[aiMode] ?? 'vindictive';
}

// ─────────────────────────────────────────────────────────
//  VOTING PHASE
// ─────────────────────────────────────────────────────────

function _actionVote(state, playerId, player) {
  const accusedId = state.blameAccusedId;
  const leaderId  = state.projectLeaderId;

  // Vote based on suspicion — who is more suspicious?
  _updateSuspicion(state, playerId, player);
  const accusedSus = player.suspicionScores[accusedId] ?? 0;
  const leaderSus  = player.suspicionScores[leaderId]  ?? 0;

  const voteFor = accusedSus >= leaderSus ? accusedId : leaderId;
  return { type: 'CAST_VOTE', voteFor };
}

// ─────────────────────────────────────────────────────────
//  SNITCH PHASE
// ─────────────────────────────────────────────────────────

function _actionSnitch(state, playerId, player) {
  const myPartyTop = player.partyPile[player.partyPile.length - 1];
  const myVal      = myPartyTop ? (myPartyTop.type === 'effort' ? myPartyTop.value : 0) : 0;

  // Collect eligible targets (not already snitched this turn)
  const alreadySnitched = state.snitchedThisTurn || [];
  const others = activePlayers(state).filter(id => id !== playerId && !alreadySnitched.includes(id));
  // If no eligible targets, pass
  if (others.length === 0) return { type: 'SNITCH_PASS' };

  // ── Play To Win: deterministic probability from inferred cards ──
  if (player.aiMode === 'play_to_win') {
    let countGe = 0;
    for (const id of others) {
      const projCard = state.projectPile.find(c => c.playerId === id);
      let inferredVal = 4;
      if (projCard && projCard.revealed && projCard.type === 'effort') {
        inferredVal = Math.max(0, 8 - projCard.value);
      }
      if (inferredVal >= myVal) countGe++;
    }
    const pSnitch = countGe / Math.max(1, others.length) + 0.05;
    if (Math.random() < pSnitch) return _pickSnitchTarget(state, playerId, player, others);
    return { type: 'SNITCH_PASS' };
  }

  let confirmedAbove = 0;
  let confirmedEqual = 0;
  let estimatedAbove = 0;

  for (const id of others) {
    const projCard = state.projectPile.find(c => c.playerId === id);
    if (projCard && projCard.revealed && projCard.type === 'effort') {
      const inferred = Math.max(0, 8 - projCard.value);
      if (inferred > myVal)  confirmedAbove += 1;
      else if (inferred === myVal) confirmedEqual += 1;
    } else {
      // Unknown — estimate 0.5 probability of being above or equal
      estimatedAbove += 0.5;
    }
  }

  // A snitch succeeds if the other player's card is >= mine (new rule)
  const confirmedWin = confirmedAbove + confirmedEqual;

  // Rule 1: no one is above or equal, few unknowns — don't snitch
  if (confirmedWin === 0 && estimatedAbove < 0.4) return { type: 'SNITCH_PASS' };
  // Rule 2: confirmed win available — always snitch
  if (confirmedWin >= 1) {
    return _pickSnitchTarget(state, playerId, player, others);
  }

  // Rule 3: Probabilistic — more aggressive than before (base 0.6)
  const pSnitch = 0.6 + (0.4 * estimatedAbove / Math.max(1, others.length));
  if (Math.random() < pSnitch) {
    return _pickSnitchTarget(state, playerId, player, others);
  }
  return { type: 'SNITCH_PASS' };
}

function _pickSnitchTarget(state, playerId, player, others) {
  // Filter out players already snitched this turn (can only be snitched once)
  const alreadySnitched = state.snitchedThisTurn || [];
  const eligible = others.filter(id => !alreadySnitched.includes(id));
  if (eligible.length === 0) return { type: 'SNITCH_PASS' };

  // Target the player with the highest inferred party pile card
  let bestId  = null;
  let bestVal = -1;

  for (const id of eligible) {
    const projCard = state.projectPile.find(c => c.playerId === id);
    let inferred = 4; // default estimate
    if (projCard && projCard.revealed && projCard.type === 'effort') {
      inferred = Math.max(0, 8 - projCard.value);
    }
    if (inferred > bestVal) { bestVal = inferred; bestId = id; }
  }

  return bestId
    ? { type: 'SNITCH_TARGET', targetId: bestId }
    : { type: 'SNITCH_PASS' };
}

// ─────────────────────────────────────────────────────────
//  SEMESTER BREAK DRAW
// ─────────────────────────────────────────────────────────

function _actionDrawPair(state, playerId, player) {
  const available = getAvailablePairKeys(state, playerId);
  if (available.length === 0) {
    // No pair available — skip (shouldn't normally happen)
    return { type: 'DRAW_PAIR', key: null };
  }

  // Strategy: prefer higher-value pairs to maximise party pile
  const scored = available.map(key => {
    if (key === 'copy+copy') return { key, score: 100 }; // copy pairs very valuable
    const [a, b] = key.split('+').map(Number);
    return { key, score: Math.max(a, b) };
  });
  scored.sort((x, y) => y.score - x.score);

  return { type: 'DRAW_PAIR', key: scored[0].key };
}
