/* =====================================================
   SLACKADEMICS — Game State (Rulebook v2)
   Fixed starting hand, pair mechanic, project targets
   table, leadership skills, voting, snitch chain.
   ===================================================== */
'use strict';

import { shuffle, uid } from './utils.js';

// ── Constants ─────────────────────────────────────────────
export const FAIL_LIMIT      = 5;
export const TOTAL_SEMESTERS = 8;
/** Semesters after which a Semester Break (card draw) occurs */
export const BREAK_SEMESTERS = new Set([2, 4, 6]);

// ── Card display data ─────────────────────────────────────
export const CARD_NAMES = {
  0:'Checked Out', 1:'Phone It In', 2:'Half Baked', 3:'Ghost Mode',
  4:'Dedication',  5:'Night Owl',   6:'Laser Focus', 7:'Extra Mile',
  8:'All In',      copy:'X2 Copy',
};

// Image filenames relative to ../CARDS/Effort Cards/
export const EFFORT_IMGS = {
  0:'Effort 0.jpg', 1:'Effort 1.jpg', 2:'Effort 2.jpg', 3:'Effort 3.jpg',
  4:'Effort 4.jpg', 5:'Effort 5.jpg', 6:'Effort 6 Edit 1.jpg',
  7:'Effort 7.jpg', 8:'Effort 8.jpg', copy:'Copy.jpg',
};

// ── Fixed starting hand ───────────────────────────────────
// Each player receives exactly these 10 cards.
// 0 and 8 are NOT in starting hands — only available from pool draws.
export const STARTING_HAND_VALUES = [1, 2, 3, 4, 4, 5, 6, 7, 'copy', 'copy'];

// ── Valid pool pairs (for semester break draws) ───────────
export const POOL_PAIRS = [
  [0, 8], [1, 7], [2, 6], [3, 5], [4, 4], ['copy', 'copy'],
];

export function pairKey(a, b) {
  if (a === 'copy' || b === 'copy') return 'copy+copy';
  const lo = Math.min(Number(a), Number(b));
  const hi = Math.max(Number(a), Number(b));
  return `${lo}+${hi}`;
}

// ── Project targets table ─────────────────────────────────
// [semesterIndex 0-7][playerCountIndex 0-5 = 3-8 players]
export const PROJECT_TARGETS = [
  [ 7, 10, 13, 16, 19, 22],  // Semester 1 — ENGL 1201
  [ 8, 11, 14, 17, 20, 23],  // Semester 2 — ARTS 1202
  [ 9, 12, 15, 18, 21, 24],  // Semester 3 — HIST 2303
  [10, 13, 16, 20, 23, 26],  // Semester 4 — GEND 2304
  [11, 14, 17, 22, 25, 28],  // Semester 5 — MATH 3305
  [12, 16, 20, 24, 28, 32],  // Semester 6 — PHYS 3406
  [13, 17, 21, 26, 30, 34],  // Semester 7 — CHEM 4407
  [14, 18, 23, 28, 32, 36],  // Semester 8 — ENGG 4508
];

export const SEMESTER_NAMES = [
  'ENGL 1201','ARTS 1202','HIST 2303','GEND 2304',
  'MATH 3305','PHYS 3406','CHEM 4407','ENGG 4508',
];

export const COURSE_NAMES = [
  'Intro to Academic Writing',
  'Foundations of Visual Arts',
  'World History Survey',
  'Gender Studies',
  'Advanced Calculus',
  'Quantum Mechanics',
  'Organic Chemistry',
  'Engineering Capstone',
];

export function getTarget(semester, activeCount, difficulty = 1) {
  const semIdx = Math.max(0, Math.min(semester - 1, 7));
  const plrIdx = Math.max(0, Math.min(activeCount - 3, 5));
  const base   = PROJECT_TARGETS[semIdx][plrIdx];
  return Math.ceil(base * difficulty);
}

// ── Leadership skill cards ────────────────────────────────
export const LEADERSHIP_SKILLS = [
  { id:'diversity',  name:'Diversity is Our Strength', img:'Diversity.jpg',
    desc:'+1 Effort for each unique card VALUE in the Project Pile.' },
  { id:'realign',    name:'Realign Priorities', img:'Realign Priorities.jpg',
    desc:'Pick a player to reveal their top Party Pile card and swap it with the Project Pile card they played.' },
  { id:'allnighter', name:'Pull an All-Nighter', img:'Pull an All Nighter.jpg',
    desc:'Double the value of the final face-down Effort card.' },
  { id:'coffee',     name:'Round of Coffee', img:'Round of Coffee.jpg',
    desc:'All Project Pile cards with a value of 1, 2, or 3 are doubled.' },
  { id:'plagiarize', name:'Plagiarize', img:'Plagarize.jpg',
    desc:'The first X2 Copy card in the Project Pile becomes X3.' },
  { id:'curve',      name:'Curve the Grade', img:'Curve the grade.jpg',
    desc:'Subtract 6 from the Effort required. Increase next semester\'s Effort by 6.' },
  { id:'vibe',       name:'Match My Vibe', img:'Match My Vibe.jpg',
    desc:'+4 Effort for each pair of matching values in the Project Pile.' },
  { id:'reputation', name:'Positive Reputation', img:'Reputation.jpg',
    desc:'+2 Effort for each Extra Credit earned this game.' },
  { id:'evenodds',   name:'Even the Odds', img:'Even the Odds.jpg',
    desc:'All odd-numbered effort cards in the Project Pile now have a value of 4.' },
  { id:'complain',   name:'Complain to the Dean', img:'Complain.jpg',
    desc:'Remove the two lowest Effort cards from the Project Pile. Add 8 Effort.' },
  { id:'eureka',     name:'Eureka!', img:'Eureka.jpg',
    desc:'+5 Effort. Additional +5 if this card was chosen face-down.' },
  { id:'desperation',name:'Desperation', img:'Desperation.jpg',
    desc:'+5 Effort for each project the group has failed.' },
];

// ── Card factory ──────────────────────────────────────────
export function makeCard(value) {
  return {
    id:    uid('c'),
    value,
    type:  value === 'copy' ? 'copy' : 'effort',
    name:  CARD_NAMES[value] ?? String(value),
  };
}

// ── Build the effort pool ─────────────────────────────────
// Generous supply so semester-break draws always work.
export function buildInitialPool() {
  const pool = [];
  const counts = { 0:8, 1:8, 2:8, 3:8, 4:8, 5:8, 6:8, 7:8, 8:8, copy:16 };
  for (const [v, count] of Object.entries(counts)) {
    const value = v === 'copy' ? 'copy' : Number(v);
    for (let i = 0; i < count; i++) pool.push(makeCard(value));
  }
  return pool;
}

// ── Total fail count helper ───────────────────────────────
export function totalFails(player) {
  return (player.groupFails || 0) + (player.individualFails || 0);
}

// ── Create a fresh player ─────────────────────────────────
function makePlayer(cfg) {
  return {
    id:      cfg.id,
    name:    cfg.name,
    isHuman: !!cfg.isHuman,
    aiMode:  cfg.aiMode || 'regular',

    hand:      [],   // current effort cards
    partyPile: [],   // accumulated face-down party pile

    groupFails:      0,
    individualFails: 0,
    isExpelled:      false,
    extraCredits:    0,

    // Per-semester (reset each semester)
    playedPair:          false,
    semesterProjectCard: null,   // { id, value }
    semesterPartyCard:   null,

    // Cards to discard at end of semester (from blame/snitch)
    markedForDiscard: [],   // array of partyPile indices

    // AI memory
    suspicionScores:  {},   // { playerId: cumulativeInferredParty }
    blamedByHistory:  [],   // [playerId] of players who blamed this AI
    drawnPairs:       [],   // pair keys already drawn: ['0+8', 'copy+copy', ...]

    academicPoints: 0,
  };
}

// ── createState ───────────────────────────────────────────
export function createState(playerConfigs, difficulty = 1) {
  const playerOrder = playerConfigs.map(p => p.id);
  const players = {};

  for (const cfg of playerConfigs) {
    const p = makePlayer(cfg);
    p.hand = STARTING_HAND_VALUES.map(v => makeCard(v));
    players[cfg.id] = p;
  }

  const effortPool     = buildInitialPool();
  const leadershipDeck = shuffle([...LEADERSHIP_SKILLS]);
  const faceUpSkill    = leadershipDeck.shift() ?? null;
  const faceDownSkill  = leadershipDeck.shift() ?? null;
  const activeCount    = playerOrder.length;

  return {
    // ── Phase & progress ──────────────────────────────────
    // Phases: PLAYING | REVEAL | DEADLINE | BLAME | BLAME_VOTE |
    //         SNITCH | BREAK | BREAK_DRAW | GAMEOVER
    phase:          'PLAYING',
    semester:       1,
    totalSemesters: TOTAL_SEMESTERS,
    semesterName:   SEMESTER_NAMES[0],

    // ── Project ───────────────────────────────────────────
    difficulty,
    projectTarget:     getTarget(1, activeCount, difficulty),
    targetBonus:       0,   // can be negative (Curve the Grade)
    nextTargetPenalty: 0,   // applied next semester
    effortPool,
    projectPile:       [],

    // ── Turn management ───────────────────────────────────
    playerOrder,
    activePlayerId:  playerOrder[0],
    projectLeaderId: playerOrder[0],

    // ── Players ───────────────────────────────────────────
    players,

    // ── Leadership skills ─────────────────────────────────
    leadershipDeck,
    faceUpSkill,
    faceDownSkill,
    chosenSkill:          null,
    chosenSkillWasFaceDown: false,
    pendingSkillStep:     null,   // 'realign-pick-target' | null
    skillEffects:         {},
    realignTargetId:      null,

    // ── Blame & voting ────────────────────────────────────
    blameAccusedId:       null,
    blameVotes:           {},    // { voterId: targetId }
    blameVotersRemaining: [],

    // ── Snitch chain ──────────────────────────────────────
    snitchCurrentId: null,
    snitchChain:     [],

    // ── Semester break draw ───────────────────────────────
    breakDrawOrder:   [],
    breakDrawCurrent: null,

    // ── Tracking ──────────────────────────────────────────
    projectsFailed: 0,

    // ── Game log ──────────────────────────────────────────
    log: [],
  };
}

// ── Log helper ────────────────────────────────────────────
export function addLog(state, { type, text, playerId = null }) {
  state.log.push({
    id:       uid('log'),
    semester: state.semester,
    type,
    text,
    playerId,
  });
}
