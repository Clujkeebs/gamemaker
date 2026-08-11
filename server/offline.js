// The no-API-key path.
//
// Rumpus without ANTHROPIC_API_KEY still works: keyword classification, a
// palette picked from the words you used, and a procedurally generated level.
// It is obviously dumber than the model, and it is honest about that in the UI.
// It exists because a demo that dies on a missing env var is a demo that dies.

import { rng, hashString, mix } from '../shared/draw.js';
import { checkLevel, repairLevel } from '../shared/levelcheck.js';
import { get, exampleConfig } from './registry.js';
import { STYLE_NAMES } from '../shared/styles.js';

// --- classification ---------------------------------------------------------

const SIGNALS = {
  'top-down-shooter': ['shoot', 'shooter', 'gun', 'blast', 'bullet', 'laser', 'wave', 'defend', 'invasion', 'swarm', 'army', 'zombie', 'alien', 'turret', 'fight off', 'survive'],
  'breakout-clone': ['brick', 'break', 'smash', 'paddle', 'bounce', 'ball', 'breakout', 'demolish', 'wall of', 'knock down', 'shatter'],
  'top-down-collector': ['collect', 'gather', 'maze', 'sneak', 'stealth', 'avoid', 'escape', 'loot', 'steal', 'rob', 'heist', 'burgl', 'patrol', 'guard', 'hoard', 'find', 'explore', 'top down', 'top-down', 'overhead', 'pick up', 'grab', 'harvest'],
  'platformer-classic': ['jump', 'platform', 'platformer', 'leap', 'hop', 'climb', 'side scroll', 'side-scroll', 'gravity', 'spikes', 'flag', 'run and jump', 'ninja', 'mario'],
};

export function classifyOffline(prompt) {
  const text = ` ${prompt.toLowerCase()} `;
  let best = 'platformer-classic';
  let bestScore = 0;
  for (const [id, words] of Object.entries(SIGNALS)) {
    let score = 0;
    for (const w of words) if (text.includes(w)) score += w.includes(' ') ? 3 : 2;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  // The spec's tie-break: prefer the simplest, most robust archetype.
  return { template_id: best, confident: bestScore >= 2 };
}

// --- palettes ---------------------------------------------------------------

const PALETTES = {
  forest:  { words: ['forest', 'jungle', 'tree', 'bamboo', 'woods', 'leaf', 'moss', 'nature'], sky: ['#1d4f3f', '#0a1a16'], solid: '#3f6b52', accent: '#ffe6a7', hero: '#f4f1de', foe: '#c96a4a', item: '#ffd166', backdrop: 'forest' },
  space:   { words: ['space', 'moon', 'star', 'galaxy', 'alien', 'astronaut', 'planet', 'orbit', 'cosmic', 'rocket'], sky: ['#241a3d', '#0a0713'], solid: '#6b5d8a', accent: '#8be9fd', hero: '#f8f8f2', foe: '#ff79c6', item: '#8be9fd', backdrop: 'stars' },
  ocean:   { words: ['ocean', 'sea', 'underwater', 'fish', 'reef', 'diver', 'submarine', 'water', 'coral'], sky: ['#0b3954', '#04141f'], solid: '#1b6b93', accent: '#4ecdc4', hero: '#ffe66d', foe: '#ff6b6b', item: '#4ecdc4', backdrop: 'none' },
  city:    { words: ['city', 'street', 'rooftop', 'urban', 'neon', 'downtown', 'skyscraper', 'market', 'shop'], sky: ['#2b1b3d', '#0d0716'], solid: '#4a3b6b', accent: '#ff006e', hero: '#ffd60a', foe: '#8338ec', item: '#ff006e', backdrop: 'city' },
  cave:    { words: ['cave', 'dungeon', 'mine', 'underground', 'crystal', 'tunnel', 'crypt', 'dark'], sky: ['#1a1423', '#08060c'], solid: '#4a3f55', accent: '#f7b267', hero: '#c8d3dd', foe: '#e5533d', item: '#f7b267', backdrop: 'none' },
  candy:   { words: ['candy', 'sweet', 'cake', 'donut', 'sugar', 'cookie', 'ice cream', 'bakery', 'gum'], sky: ['#3d1f33', '#160b13'], solid: '#a44a7a', accent: '#8be9fd', hero: '#fff5f8', foe: '#ff5d8f', item: '#ffd166', backdrop: 'hills' },
  ice:     { words: ['ice', 'snow', 'winter', 'frozen', 'arctic', 'penguin', 'glacier', 'frost'], sky: ['#12354f', '#061520'], solid: '#4c8fbd', accent: '#ffd166', hero: '#e8f7ff', foe: '#5470c6', item: '#bfe6ff', backdrop: 'hills' },
  desert:  { words: ['desert', 'sand', 'dune', 'cactus', 'pyramid', 'oasis', 'camel', 'canyon'], sky: ['#c98a4b', '#5a3a22'], solid: '#8a5a34', accent: '#ffe066', hero: '#fff3d6', foe: '#7a3b2e', item: '#ffe066', backdrop: 'hills' },
  haunted: { words: ['haunted', 'ghost', 'spooky', 'graveyard', 'vampire', 'witch', 'halloween', 'skeleton', 'horror', 'library'], sky: ['#1b1029', '#0a0512'], solid: '#3f2b56', accent: '#a3ff8f', hero: '#e6e1ff', foe: '#c77dff', item: '#a3ff8f', backdrop: 'stars' },
  lab:     { words: ['lab', 'robot', 'factory', 'machine', 'cyber', 'circuit', 'tech', 'science', 'greenhouse'], sky: ['#0f1c22', '#050c0f'], solid: '#2f5d5b', accent: '#00e5ff', hero: '#c8f5ff', foe: '#ff5f56', item: '#00e5ff', backdrop: 'city' },
};

function pickPalette(prompt) {
  const text = prompt.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [name, p] of Object.entries(PALETTES)) {
    const score = p.words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = { name, ...p };
    }
  }
  if (best) return best;
  const names = Object.keys(PALETTES);
  const name = names[hashString(prompt) % names.length];
  return { name, ...PALETTES[name] };
}

// --- copy -------------------------------------------------------------------

const STOP = new Set(['a', 'an', 'the', 'game', 'about', 'where', 'with', 'that', 'this', 'and', 'you', 'your', 'make', 'create', 'build', 'of', 'in', 'on', 'to', 'is', 'are', 'has', 'have', 'it', 'its', 'for', 'from', 'who', 'must', 'they', 'them', 'their', 'while', 'through', 'into']);

function titleFrom(prompt) {
  const words = prompt
    .replace(/[^a-z0-9\s'-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w.toLowerCase()));
  const picked = words.slice(0, 3);
  if (!picked.length) return 'Untitled Rumpus';
  return picked.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Things a game plausibly asks you to pick up. Grabbing an arbitrary word out
// of the prompt gives HUD labels like "wall 0/4" — worse than a sane default,
// so only use a word that actually reads as a collectible.
const COLLECTIBLES = [
  'coins', 'gems', 'stars', 'keys', 'fish', 'snacks', 'scrolls', 'bolts', 'cores',
  'books', 'pearls', 'flowers', 'apples', 'bones', 'eggs', 'seeds', 'crystals',
  'batteries', 'oxygen', 'treats', 'cheese', 'donuts', 'candy', 'gold', 'orbs',
  'shells', 'leaves', 'berries', 'nuts', 'parts', 'scraps', 'data', 'souls',
];

function noun(prompt, fallback = 'loot') {
  const text = prompt.toLowerCase();
  // Match the plural we display, but accept the singular in the prompt.
  const found = COLLECTIBLES.find((c) => text.includes(c) || text.includes(c.replace(/s$/, '')));
  return (found ?? fallback).slice(0, 12);
}

// --- art direction ----------------------------------------------------------

// Which style a prompt is asking for, when it doesn't say. These are the words
// that actually imply a look rather than a subject.
const STYLE_SIGNALS = {
  neon: ['neon', 'cyber', 'synthwave', 'arcade', 'retrowave', 'hologram', 'laser', 'glow', 'vapor', 'techno', 'night city', 'blade'],
  storybook: ['storybook', 'fairy', 'fairytale', 'picture book', 'hand drawn', 'watercolour', 'watercolor', 'cosy', 'cozy', 'woodland', 'medieval', 'folk', 'library', 'village'],
  clay: ['clay', 'plasticine', 'toy', 'soft', 'cute', 'pastel', 'bouncy', 'squishy', 'candy', 'plush', 'rounded', 'kid'],
  pixel: ['pixel', '8-bit', '8 bit', '16-bit', '16 bit', 'retro', 'nes', 'gameboy', 'chunky', 'classic'],
};

function pickStyle(prompt) {
  const text = prompt.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [name, words] of Object.entries(STYLE_SIGNALS)) {
    const score = words.reduce((n, w) => n + (text.includes(w) ? (w.includes(' ') ? 2 : 1) : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  // Pixel is the default for the same reason platformer-classic is: it is the
  // most robust choice when the prompt gives you nothing to go on.
  return STYLE_NAMES.includes(best) ? best : 'pixel';
}

// Creature words → a body plan and the parts that make it recognisable. Order
// matters: the first match wins, so put specific animals before general ones.
const CREATURES = [
  [['cat', 'kitten', 'tiger', 'lion', 'panther', 'ninja cat'], { build: 'quadruped', features: ['earsPointed', 'tail'], pattern: 'stripes' }],
  [['dog', 'puppy', 'wolf', 'fox', 'hound', 'corgi'], { build: 'quadruped', features: ['earsPointed', 'tail'], pattern: 'none' }],
  [['raccoon', 'badger', 'possum', 'squirrel', 'rat', 'mouse', 'hamster'], { build: 'quadruped', features: ['earsRound', 'tail'], pattern: 'stripes' }],
  [['bear', 'panda', 'sheep', 'cow', 'pig', 'goat', 'horse', 'deer'], { build: 'quadruped', features: ['earsRound', 'tail'], pattern: 'spots' }],
  [['bird', 'chicken', 'duck', 'penguin', 'owl', 'crow', 'parrot', 'chick'], { build: 'bird', features: [], pattern: 'belly' }],
  [['fish', 'shark', 'salmon', 'koi', 'eel', 'whale', 'dolphin'], { build: 'fish', features: [], pattern: 'stripes' }],
  [['robot', 'android', 'droid', 'mech', 'machine', 'cyborg'], { build: 'biped', features: ['visor', 'antenna'], eyes: 'visor', pattern: 'plated' }],
  [['ghost', 'spirit', 'phantom', 'spectre', 'specter', 'wraith'], { build: 'ghost', features: [], pattern: 'none' }],
  [['slime', 'blob', 'goo', 'jelly', 'ooze', 'pudding'], { build: 'blob', features: [], pattern: 'belly' }],
  [['bug', 'beetle', 'ant', 'spider', 'wasp', 'bee', 'insect', 'roach'], { build: 'bug', features: ['horns'], pattern: 'plated' }],
  [['ship', 'rocket', 'spacecraft', 'fighter', 'shuttle', 'ufo'], { build: 'ship', features: [], eyes: 'none', pattern: 'none' }],
  [['car', 'kart', 'truck', 'racer', 'buggy', 'van'], { build: 'car', features: [], eyes: 'none', pattern: 'none' }],
  [['knight', 'warrior', 'soldier', 'guard', 'hero', 'wizard', 'witch', 'astronaut', 'diver', 'chef', 'person', 'kid'], { build: 'biped', features: [], pattern: 'none' }],
  [['dragon', 'demon', 'devil', 'monster', 'beast', 'troll'], { build: 'biped', features: ['horns', 'wings'], eyes: 'angry', pattern: 'plated' }],
  [['crystal', 'shard', 'crystalline'], { build: 'crystal', features: [], eyes: 'none', pattern: 'none' }],
  [['king', 'queen', 'prince', 'princess', 'royal'], { build: 'biped', features: ['crown', 'cape'], pattern: 'none' }],
];

/** Read a creature out of the prompt; fall back to something sensible. */
function creatureFrom(prompt, fallback, { angry = false } = {}) {
  const text = prompt.toLowerCase();
  for (const [words, spec] of CREATURES) {
    if (words.some((w) => text.includes(w))) {
      return { eyes: angry ? 'angry' : 'big', pattern: 'none', features: [], ...spec };
    }
  }
  return { eyes: angry ? 'angry' : 'big', pattern: 'none', features: [], ...fallback };
}

// Collectible word → the icon that draws it.
const ICONS = {
  coin: ['coin', 'gold', 'money', 'cash', 'treasure'],
  gem: ['gem', 'jewel', 'diamond', 'crystal', 'emerald', 'ruby'],
  star: ['star', 'sparkle', 'light'],
  heart: ['heart', 'love', 'life'],
  key: ['key', 'lock', 'door'],
  fruit: ['fruit', 'apple', 'berry', 'cherry', 'food', 'snack', 'tomato'],
  bolt: ['bolt', 'power', 'energy', 'battery', 'charge', 'lightning', 'core'],
  shell: ['shell', 'ocean', 'sea', 'beach'],
  skull: ['skull', 'bone', 'death', 'haunted', 'spooky'],
  orb: ['orb', 'ball', 'bubble', 'sphere'],
};

function iconFrom(prompt, fallback = 'coin') {
  const text = prompt.toLowerCase();
  for (const [icon, words] of Object.entries(ICONS)) {
    if (words.some((w) => text.includes(w))) return icon;
  }
  return fallback;
}

// --- level generation -------------------------------------------------------

function genPlatformerGrid(rand, { cols = 34, rows = 13, density = 0.5 } = {}) {
  const g = Array.from({ length: rows }, () => Array(cols).fill('.'));
  const floor = rows - 1;
  for (let x = 0; x < cols; x++) g[floor][x] = '#';

  // Pits: 1-2 tiles wide, well inside the default jump's horizontal reach. The
  // reachability check still verifies it, and reseeds if a roll makes a level
  // that can't be finished.
  for (let x = 6; x < cols - 6; x++) {
    if (rand() < 0.12) {
      const w = 1 + Math.floor(rand() * 2);
      for (let i = 0; i < w && x + i < cols - 4; i++) g[floor][x + i] = '.';
      x += w + 3;
    }
  }

  let platforms = 0;
  for (let y = floor - 2; y >= 2; y -= 2) {
    for (let x = 3; x < cols - 4; x++) {
      if (rand() > density * 0.14) continue;
      const w = 2 + Math.floor(rand() * 4);
      if (x + w >= cols - 3) continue;
      for (let i = 0; i < w; i++) g[y][x + i] = rand() < 0.25 ? '-' : '#';
      if (rand() < 0.7) g[y - 1][x + Math.floor(w / 2)] = 'o';
      platforms++;
      x += w + 2 + Math.floor(rand() * 3);
    }
  }
  if (platforms === 0) {
    for (let x = 8; x < cols - 8; x += 7) {
      for (let i = 0; i < 3; i++) g[floor - 2][x + i] = '#';
      g[floor - 3][x + 1] = 'o';
    }
  }

  for (let x = 5; x < cols - 5; x++) {
    if (g[floor][x] === '#' && g[floor - 1][x] === '.' && rand() < 0.07) {
      g[floor - 1][x] = rand() < 0.5 ? 'x' : 'e';
      x += 3;
    }
  }

  g[floor - 1][1] = 'P';
  g[floor - 1][cols - 2] = 'G';
  for (let x = cols - 4; x < cols; x++) g[floor][x] = '#';
  for (let x = 0; x < 3; x++) g[floor][x] = '#';
  return g.map((r) => r.join(''));
}

/**
 * Randomized-DFS maze. Every open cell is connected to every other by
 * construction, so a collector level generated this way is never unwinnable —
 * the reachability check that follows is a belt-and-braces assertion, not a
 * filter that ever has to reject anything.
 */
function genMazeGrid(rand, { cols = 25, rows = 13, openness = 0.12, pickups = 8, enemies = 3 } = {}) {
  const w = cols % 2 ? cols : cols - 1;
  const h = rows % 2 ? rows : rows - 1;
  const g = Array.from({ length: h }, () => Array(w).fill('#'));

  const stack = [[1, 1]];
  g[1][1] = '.';
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const opts = [[2, 0], [-2, 0], [0, 2], [0, -2]]
      .map(([dx, dy]) => [x + dx, y + dy])
      .filter(([nx, ny]) => nx > 0 && ny > 0 && nx < w - 1 && ny < h - 1 && g[ny][nx] === '#');
    if (!opts.length) {
      stack.pop();
      continue;
    }
    const [nx, ny] = opts[Math.floor(rand() * opts.length)];
    g[(y + ny) / 2][(x + nx) / 2] = '.';
    g[ny][nx] = '.';
    stack.push([nx, ny]);
  }

  // Knock out extra walls so it plays as a room rather than a corridor puzzle.
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++)
      if (g[y][x] === '#' && rand() < openness) g[y][x] = '.';

  const open = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) if (g[y][x] === '.') open.push([x, y]);

  const far = open.filter(([x, y]) => x + y > (w + h) * 0.55);
  const shuffled = open.slice().sort(() => rand() - 0.5);

  g[1][1] = 'P';
  const goal = far.length ? far[Math.floor(rand() * far.length)] : shuffled[shuffled.length - 1];
  g[goal[1]][goal[0]] = 'G';

  let placed = 0;
  for (const [x, y] of shuffled) {
    if (placed >= pickups) break;
    if (g[y][x] !== '.' || (x < 4 && y < 4)) continue;
    g[y][x] = 'o';
    placed++;
  }
  let foes = 0;
  for (const [x, y] of shuffled.slice().reverse()) {
    if (foes >= enemies) break;
    if (g[y][x] !== '.' || x + y < 8) continue;
    g[y][x] = 'e';
    foes++;
  }
  return g.map((r) => r.join(''));
}

// --- config synthesis -------------------------------------------------------

function buildConfig(templateId, prompt, seedNum) {
  const rand = rng(seedNum || 1);
  const pal = pickPalette(prompt);
  const base = structuredClone(exampleConfig(templateId) ?? {});
  const wantsHard = /hard|brutal|tough|difficult|fast|frantic|impossible/i.test(prompt);
  const wantsEasy = /easy|gentle|chill|relaxing|kid|casual|simple/i.test(prompt);
  const diff = wantsHard ? 1.25 : wantsEasy ? 0.78 : 1;
  const items = noun(prompt, templateId === 'platformer-classic' ? 'coins' : 'loot');

  const cfg = { ...base, seed: seedNum % 999999, style: pickStyle(prompt) };

  // Split the prompt at the word that separates protagonist from antagonist,
  // and read each side independently. Scanning the whole string for both makes
  // "defend the greenhouse from beetles" turn the player into a beetle.
  const [heroText, foeText = ''] = prompt.split(
    /\b(?:dodging|dodge|avoiding|avoid|chased by|hunted by|fighting|battling|attacked by|versus|vs\.?|against|from|while|escaping|fleeing)\b/i
  );
  const heroBuild = templateId === 'top-down-shooter' ? 'ship' : 'biped';
  const heroSpec = creatureFrom(heroText, { build: heroBuild, eyes: heroBuild === 'ship' ? 'none' : 'big' });
  const foeSpec = creatureFrom(foeText || prompt, { build: 'blob' }, { angry: true });

  switch (templateId) {
    case 'platformer-classic':
      cfg.theme = {
        skyTop: pal.sky[0], skyBottom: pal.sky[1], ground: pal.solid, accent: pal.accent,
        player: pal.hero, enemy: pal.foe, pickup: pal.item, goal: '#7ee787',
        hazard: '#ff4d6d', backdrop: pal.backdrop, pickupName: items,
      };
      cfg.entities = {
        player: { size: 13, sprite: heroSpec },
        enemy: { size: 14, speed: Math.round(38 * diff), behavior: /chase|hunt|follow/i.test(prompt) ? 'chase' : 'patrol', sprite: foeSpec },
        pickup: { size: 9, icon: iconFrom(prompt, 'coin') },
      };
      cfg.level = { tileSize: 18, grid: genPlatformerGrid(rand, { density: diff }) };
      cfg.physics = {
        gravity: /moon|space|float|low gravity/i.test(prompt) ? 400 : 740,
        moveSpeed: Math.round(98 * diff), jumpPower: /moon|space|float|low gravity/i.test(prompt) ? 300 : 265, friction: 15,
      };
      cfg.rules = { win: 'reachGoal', goalNeedsAll: false, surviveSeconds: 45, lives: wantsHard ? 2 : 3, timeLimit: 0, pickupScore: 25 };
      cfg.mechanicHooks = [
        ...(/double.?jump|ninja|wall/i.test(prompt) ? ['doubleJump'] : []),
        ...(/dash|dodge|roll|speed/i.test(prompt) ? ['dash'] : []),
        ...(/stomp|squash|jump on/i.test(prompt) ? ['stomp'] : []),
      ].slice(0, 3);
      break;

    case 'top-down-collector':
      cfg.theme = {
        // Lifted off the palette's darkest value: a top-down floor is a surface
        // you read tile-by-tile, not a backdrop, and near-black floors go
        // unreadable the moment a hook like lantern dims them further.
        floor: mix(pal.sky[1], pal.solid, 0.34),
        wall: pal.solid, accent: pal.accent, player: pal.hero,
        enemy: pal.foe, pickup: pal.item, goal: '#a78bfa', hazard: '#ff4d6d',
        floorPattern: 'checker', pickupName: items,
      };
      cfg.entities = {
        player: { size: 12, sprite: heroSpec },
        enemy: { size: 13, speed: Math.round(42 * diff), behavior: /chase|hunt|guard|patrol/i.test(prompt) ? 'chase' : 'patrol', sprite: foeSpec },
        pickup: { size: 9, icon: iconFrom(prompt, 'star') },
      };
      cfg.level = { tileSize: 20, grid: genMazeGrid(rand, { pickups: 8, enemies: wantsHard ? 5 : 3 }) };
      cfg.movement = { speed: Math.round(94 * (wantsHard ? 1.05 : 1)), accel: 20, diagonal: true };
      cfg.rules = { win: /escape|exit|reach|get out/i.test(prompt) ? 'reachGoal' : 'collectAll', goalNeedsAll: false, surviveSeconds: 40, lives: 3, timeLimit: 0, pickupScore: 20 };
      cfg.mechanicHooks = [
        ...(/dark|night|stealth|sneak|lantern|torch/i.test(prompt) ? ['lantern'] : []),
        ...(/dash|dodge|fast/i.test(prompt) ? ['dash'] : []),
        ...(/magnet|vacuum|suck/i.test(prompt) ? ['magnet'] : []),
      ].slice(0, 3);
      break;

    case 'top-down-shooter':
      cfg.theme = { floor: pal.sky[1], wall: pal.solid, accent: pal.accent, player: pal.hero, enemy: pal.foe, floorPattern: 'grid' };
      cfg.entities = {
        player: { size: 15, sprite: heroSpec },
        enemy: { size: 14, speed: Math.round(44 * diff), hp: 2, behavior: /shoot back|ranged|gun/i.test(prompt) ? 'shooter' : 'rush', fireEvery: 1.8, sprite: foeSpec },
      };
      cfg.arena = { coverCount: 5 };
      cfg.movement = { speed: 110, accel: 22 };
      cfg.combat = { aim: 'mouse', fireRate: 5, bulletSpeed: 330, damage: 1 };
      cfg.waves = { count: wantsHard ? 8 : 5, baseEnemies: 4, ramp: 1.5 * diff, hpRamp: 0.34, restBetween: 2 };
      cfg.rules = { win: /survive|endless|hold out|last/i.test(prompt) ? 'survive' : 'clearWaves', surviveSeconds: 60, health: wantsHard ? 2 : 3, killScore: 15 };
      cfg.mechanicHooks = [
        ...(/spread|shotgun|scatter/i.test(prompt) ? ['spread'] : []),
        ...(/pierce|through/i.test(prompt) ? ['pierce'] : []),
        ...(/dodge|roll|dash/i.test(prompt) ? ['dashRoll'] : []),
        ...(/shield|block/i.test(prompt) ? ['shield'] : []),
        ...(/homing|seek|track/i.test(prompt) ? ['homing'] : []),
      ].slice(0, 3);
      break;

    case 'breakout-clone':
      cfg.theme = { background: pal.sky[1], paddle: pal.hero, ball: '#ffffff', brickTop: pal.foe, brickBottom: pal.item, accent: pal.accent };
      cfg.paddle = { width: wantsHard ? 48 : 64, speed: 320 };
      cfg.ball = { size: 7, speed: Math.round(165 * diff), maxSpeed: 260, accel: 1.6 };
      cfg.bricks = { rows: wantsHard ? 7 : 5, cols: 10, hp: 2, pattern: ['solid', 'checker', 'pyramid', 'gaps', 'arch'][Math.floor(rand() * 5)] };
      cfg.rules = { lives: wantsHard ? 2 : 3, brickScore: 15, powerupChance: 0.16 };
      cfg.mechanicHooks = ['multiball', 'widen'];
      cfg.powerupIcon = iconFrom(prompt, 'star');
      break;
  }
  return cfg;
}

// --- entry point ------------------------------------------------------------

export function generateOffline(prompt, forcedTemplate = null) {
  const cls = forcedTemplate ? { template_id: forcedTemplate, confident: true } : classifyOffline(prompt);
  const template = get(cls.template_id);
  const seedBase = hashString(prompt);

  // Reseed on an unwinnable level before falling back to carving a corridor.
  let cfg = null;
  let check = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    cfg = buildConfig(cls.template_id, prompt, seedBase + attempt * 7919);
    check = template.schema.reachability ? checkLevel(template.schema, cfg) : { ok: true, reasons: [] };
    if (check.ok) break;
  }
  let repaired = false;
  if (check && !check.ok) {
    const fix = repairLevel(template.schema, cfg);
    cfg = fix.config;
    repaired = fix.repaired;
    check = fix.check;
  }

  return {
    template_id: cls.template_id,
    template_version: template.schema.version,
    config: cfg,
    title: titleFrom(prompt),
    description: `${template.schema.blurb} Built from: "${prompt.slice(0, 90)}".`,
    source: 'offline',
    notes: {
      confident: cls.confident,
      repaired,
      reachability: check?.reasons ?? [],
    },
  };
}
