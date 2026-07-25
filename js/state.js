/* =====================================================
   SLACKADEMICS — Game State (Rulebook v2)
   Fixed starting hand, pair mechanic, project targets
   table, leadership skills, voting, snitch chain.
   ===================================================== */
'use strict';

import { shuffle, uid } from './utils.js?v=6';

// ── Constants ─────────────────────────────────────────────
export const FAIL_LIMIT      = 5;
export const TOTAL_SEMESTERS = 8;
/** Semesters after which a Semester Break (card draw) occurs */
export const BREAK_SEMESTERS = new Set([2, 4, 6]);

// ── Card display data ─────────────────────────────────────
export const CARD_NAMES = {
  // Regular effort cards
  0:'Checked Out', 1:'Phone It In', 2:'Half Baked', 3:'Ghost Mode',
  4:'Dedication',  5:'Night Owl',   6:'Laser Focus', 7:'Extra Mile',
  8:'All In',      copy:'X2 Copy',
  // Special semester-break cards
  cram:   'Cram',
  cheat:  'Cheat',
  colead: 'Co-Lead',
};

// Image filenames for ./cards/effort/ (new artwork, compressed for web)
// Special cards use a composite key: type + value (e.g. 'cram6', 'cram2')
export const EFFORT_IMGS = {
  0:'0.jpg',  1:'1.jpg',  2:'2.jpg',  3:'3.jpg',
  4:'4.jpg',  5:'5.jpg',  6:'6.jpg',  7:'7.jpg',
  8:'8.jpg',  copy:'Copy.jpg',
  cram6:'cram6.jpg', cram2:'cram2.jpg',
  cheat:'cheat5.jpg', colead:'colead.jpg',
};

// ── Fixed starting hand ───────────────────────────────────
// Each player receives exactly these 10 cards.
// 0 and 8 are NOT in starting hands — only available from pool draws.
export const STARTING_HAND_VALUES = [1, 2, 3, 4, 4, 5, 6, 7, 'copy', 'copy'];

// ── Valid pool pairs (for semester break draws) ───────────
// Each entry defines a drawable pair: key (string ID), and the two cards.
// 6 of each pair are placed in the pool; no "already drawn" restriction.
export const POOL_PAIRS = [
  { key: '0+8',    typeA: 'effort', valueA: 0,      typeB: 'effort', valueB: 8 },
  { key: 'cram',   typeA: 'cram',   valueA: 6,      typeB: 'cram',   valueB: 2 },
  { key: 'cheat',  typeA: 'cheat',  valueA: 5,      typeB: 'cheat',  valueB: 5 },
  { key: 'colead', typeA: 'colead', valueA: 4,      typeB: 'colead', valueB: 4 },
  { key: 'copy',   typeA: 'copy',   valueA: 'copy', typeB: 'copy',   valueB: 'copy' },
];

// ── Project targets table ─────────────────────────────────
// [semesterIndex 0-7][playerCountIndex 0-5 = 3-8 players]
export const PROJECT_TARGETS = [
  [ 9, 12, 15, 18, 21, 24],  // Semester 1 — ENGL 1201
  [10, 13, 17, 20, 23, 27],  // Semester 2 — ARTS 1202
  [11, 15, 19, 22, 25, 30],  // Semester 3 — HIST 2303
  [12, 16, 20, 24, 28, 32],  // Semester 4 — GEND 2304
  [13, 17, 22, 26, 30, 35],  // Semester 5 — MATH 3305
  [14, 18, 24, 28, 33, 37],  // Semester 6 — PHYS 3406
  [15, 20, 25, 30, 35, 40],  // Semester 7 — CHEM 4407
  [16, 21, 27, 32, 37, 42],  // Semester 8 — ENGG 4508
];

export const SEMESTER_NAMES = [
  'ENGL 1201','ARTS 1202','HIST 2303','GEND 2304',
  'MATH 3305','PHYS 3406','CHEM 4407','ENGG 4508',
];

export const COURSE_NAMES = [
  'English', 'Creative Arts', 'History', 'Gender Studies',
  'Mathematics', 'Physics', 'Chemistry', 'Engineering',
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
    desc:'+1 Effort for each Extra Credit earned this game.' },
  { id:'evenodds',   name:'Even the Odds', img:'Even the Odds.jpg',
    desc:'All odd-numbered effort cards in the Project Pile now have a value of 4.' },
  { id:'complain',   name:'Complain to the Dean', img:'Complain.jpg',
    desc:'Remove the two lowest Effort cards from the Project Pile. Add 8 Effort.' },
  { id:'eureka',     name:'Eureka!', img:'Eureka.jpg',
    desc:'+5 Effort. Additional +5 if this card was chosen face-down.' },
  { id:'desperation',name:'Desperation', img:'Desperation.jpg',
    desc:'+2 Effort for each Fail token currently held by the Project Leader.' },
];

// ── Card factory ──────────────────────────────────────────
// type: 'effort' | 'copy' | 'cram' | 'cheat' | 'colead'
// value: number or 'copy'
export function makeCard(value, type) {
  const resolvedType = type || (value === 'copy' ? 'copy' : 'effort');
  return {
    id:    uid('c'),
    type:  resolvedType,
    value,
    name:  CARD_NAMES[resolvedType] ?? CARD_NAMES[value] ?? String(value),
  };
}

// ── Build the effort pool ─────────────────────────────────
// Pool is used ONLY for semester-break draws.
// 6 of each pair = 6 pairs × 4 types.
export function buildInitialPool() {
  const pool = [];
  const PER_TYPE = 6;
  // 0+8 pairs
  for (let i = 0; i < PER_TYPE; i++) {
    pool.push(makeCard(0, 'effort'));
    pool.push(makeCard(8, 'effort'));
  }
  // Cram pairs (6+2)
  for (let i = 0; i < PER_TYPE; i++) {
    pool.push(makeCard(6, 'cram'));
    pool.push(makeCard(2, 'cram'));
  }
  // Cheat pairs (5+5)
  for (let i = 0; i < PER_TYPE * 2; i++) {
    pool.push(makeCard(5, 'cheat'));
  }
  // Co-Lead pairs (4+4)
  for (let i = 0; i < PER_TYPE * 2; i++) {
    pool.push(makeCard(4, 'colead'));
  }
  // X2 Copy pairs (copy+copy)
  for (let i = 0; i < PER_TYPE * 2; i++) {
    pool.push(makeCard('copy', 'copy'));
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

    hand:      [],
    partyPile: [],

    groupFails:      0,
    individualFails: 0,
    isExpelled:      false,
    extraCredits:    0,

    // Per-semester (reset each semester)
    playedPair:          false,
    semesterProjectCard: null,
    semesterPartyCard:   null,

    // Cards to discard at end of semester (from blame/snitch)
    markedForDiscard: [],

    // AI memory
    suspicionScores:  {},
    blamedByHistory:  [],
    drawnPairs:       [],   // kept for reference but no longer blocks re-draws

    academicPoints: 0,

    // Expulsion is deferred until semester break so players can finish the round
    pendingExpulsion: false,
  };
}

// ── Project card deck ─────────────────────────────────────
export const PROJECT_CARDS = [
  { filename: 'hist101.jpg',  code: 101, subject: 'HIST 101', name: 'History',       title: 'History 101',       effort: [ 9, 13, 16, 19, 22, 25] },
  { filename: 'phil101.jpg',  code: 101, subject: 'PHIL 101', name: 'Philosophy',    title: 'Philosophy 101',    effort: [ 9, 12, 15, 18, 21, 24] },
  { filename: 'psyc102.jpg',  code: 102, subject: 'PSYC 102', name: 'Psychology',    title: 'Psychology 102',    effort: [11, 15, 18, 21, 26, 30] },
  { filename: 'soc102.jpg',   code: 102, subject: 'SOC 102',  name: 'Sociology',     title: 'Sociology 102',     effort: [10, 14, 17, 20, 24, 27] },
  { filename: 'econ103.jpg',  code: 103, subject: 'ECON 103', name: 'Economics',     title: 'Economics 103',     effort: [12, 16, 20, 24, 28, 32] },
  { filename: 'stat103.jpg',  code: 103, subject: 'STAT 103', name: 'Statistics',    title: 'Statistics 103',    effort: [12, 16, 20, 24, 28, 32] },
  { filename: 'gend204.jpg',  code: 204, subject: 'GEND 204', name: 'Gender Studies',title: 'Gender Studies 204',effort: [13, 17, 22, 26, 31, 34] },
  { filename: 'music204.jpg', code: 204, subject: 'MUSC 204', name: 'Music',         title: 'Music 204',         effort: [13, 17, 21, 25, 30, 35] },
  { filename: 'eng305.jpg',   code: 305, subject: 'ENGI 305', name: 'Engineering',   title: 'Engineering 305',   effort: [14, 19, 25, 29, 34, 38] },
  { filename: 'mktg305.jpg',  code: 305, subject: 'MKTG 305', name: 'Marketing',     title: 'Marketing 305',     effort: [14, 18, 23, 28, 33, 36] },
  { filename: 'chem401.jpg',  code: 401, subject: 'CHEM 401', name: 'Chemistry',     title: 'Chemistry 401',     effort: [16, 21, 26, 31, 38, 41] },
  { filename: 'math406.jpg',  code: 406, subject: 'MATH 406', name: 'Mathematics',   title: 'Mathematics 406',   effort: [15, 20, 25, 30, 37, 40] },
];

export function pickProjectCards(n) {
  const shuffled = shuffle([...PROJECT_CARDS]);
  return shuffled.slice(0, n).sort((a, b) => a.code - b.code);
}

// ── Simple mode constants ─────────────────────────────────
export const SIMPLE_TOTAL_ROUNDS  = 6;
export const SIMPLE_FAIL_LIMIT    = 4;

export const SIMPLE_PROJECT_NAMES  = ['English','Creative Arts','Gender Studies','Philosophy','Statistica','Maths'];
export const SIMPLE_SEMESTER_NAMES = ['ENGL 1001','ARTS 1002','GEND 1003','PHIL 2004','STAT 2005','MATH 3006'];

export const SIMPLE_PROJECT_TARGETS = [
  [ 9, 12, 15, 18, 21, 24],  // Round 1 — English
  [10, 13, 18, 22, 24, 28],  // Round 2 — Creative Arts
  [11, 15, 19, 23, 26, 30],  // Round 3 — Gender Studies
  [12, 16, 21, 24, 28, 32],  // Round 4 — Philosophy
  [13, 18, 23, 28, 30, 35],  // Round 5 — Statistica
  [15, 20, 25, 30, 35, 40],  // Round 6 — Maths
];

// Full hand dealt at start — 12 cards = 6 exact pairs for 6 rounds, no draws
export const SIMPLE_STARTING_HAND_VALUES = [0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 'copy', 'copy'];

export function getSimpleTarget(card, activeCount, difficulty = 1) {
  const plrIdx = Math.max(0, Math.min(activeCount - 3, 5));
  const base   = card?.effort?.[plrIdx] ?? 10;
  return Math.ceil(base * difficulty);
}

// ── createState ───────────────────────────────────────────
export function createState(playerConfigs, difficulty = 1, coLeadFailMode = 'exam_fail', gameMode = 'traditional', options = {}) {
  const isSimple = gameMode === 'simple';
  const players = {};
  for (const cfg of playerConfigs) {
    const p = makePlayer(cfg);
    p.hand = isSimple
      ? SIMPLE_STARTING_HAND_VALUES.map(v => makeCard(v))
      : STARTING_HAND_VALUES.map(v => makeCard(v));
    players[cfg.id] = p;
  }

  const playerOrder    = shuffle(playerConfigs.map(p => p.id));
  const effortPool     = buildInitialPool();
  const leadershipDeck = shuffle([...LEADERSHIP_SKILLS]);
  const faceUpSkill    = leadershipDeck.shift() ?? null;
  const faceDownSkill  = leadershipDeck.shift() ?? null;
  const activeCount    = playerOrder.length;

  const slackerTokens = {};
  const successfulSlackOff = {};
  for (const cfg of playerConfigs) {
    slackerTokens[cfg.id]     = 0;
    successfulSlackOff[cfg.id] = 0;
  }

  const totalRounds  = isSimple ? SIMPLE_TOTAL_ROUNDS : TOTAL_SEMESTERS;
  const projectCards = pickProjectCards(totalRounds);

  return {
    phase:          'PLAYING',
    semester:       1,
    totalSemesters: totalRounds,
    semesterName:   projectCards[0]?.subject ?? (isSimple ? SIMPLE_SEMESTER_NAMES[0] : SEMESTER_NAMES[0]),
    projectCards,

    gameMode,
    failLimit: isSimple ? SIMPLE_FAIL_LIMIT : FAIL_LIMIT,

    difficulty,
    projectTarget: isSimple
      ? getSimpleTarget(projectCards[0], activeCount, difficulty)
      : getTarget(1, activeCount, difficulty),
    targetBonus:       0,
    nextTargetPenalty: 0,
    effortPool,
    projectPile:       [],

    playerOrder,
    activePlayerId:  playerOrder[0],
    projectLeaderId: playerOrder[0],

    players,

    leadershipDeck,
    faceUpSkill,
    faceDownSkill,
    chosenSkill:          null,
    chosenSkillWasFaceDown: false,
    pendingSkillStep:     null,
    skillEffects:         {},
    realignTargetId:      null,

    blameAccusedId:       null,
    blameVotes:           {},
    blameVotersRemaining: [],

    snitchCurrentId: null,
    snitchChain:     [],
    snitchedThisTurn: [],

    breakDrawOrder:   [],
    breakDrawCurrent: null,

    projectsFailed: 0,

    // End-game metadata (set when GAMEOVER is reached)
    // 'semesters-complete' | 'elimination-limit' | 'all-expelled'
    gameEndReason:  null,
    specialWinners: [],

    coLeadFailMode,

    // Simple mode — Group Evaluation (slacker voting, only after a PASS
    // without Extra Credit)
    slackerTokens,          // {playerId: count} accumulated across rounds
    roundSlackerVotes:  {}, // {voterId: targetId} current round
    evalVotersRemaining:[],
    evalRoundCounts:    {}, // {targetId: count} tally for current round
    evalAccusedId:      null,
    evalTiedPlayers:    [],

    // Simple mode — "Who's to Blame?" fail vote + Snitch chain
    // (replaces Group Evaluation whenever the project FAILS)
    roundFailVotes:           {}, // {voterId: targetId} current round
    failVoteVotersRemaining:  [],
    failRoundCounts:          {}, // {targetId: count} tally for current round
    failTiedPlayers:          [],
    simpleSnitchCurrentId:    null,
    simpleSnitchedThisRound:  [],

    simpleAppealBlamedId:     null,
    simpleSelfRevealPlayerId: null,
    successfulSlackOff,

    extraCreditAwardedThisRound: false,

    simpleVoteContext:    null,     // 'pass' | 'fail' — set when slacker vote begins
    simpleECGiftPlayerId: null,     // player the leader gifted EC to this round

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
