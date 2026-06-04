export const RUNNER_SPRITE = Object.freeze({
  frameWidth: 32,
  frameHeight: 40,
  frameCount: 6,
  scale: 1,
});

export const PLAYER_COLLISION = Object.freeze({
  height: 30,
  radius: 14,
  tagRadius: 32,
});

function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function playerBodyDistanceSq(playerA, playerB, height = PLAYER_COLLISION.height) {
  const ax = finiteOrZero(playerA?.x);
  const bx = finiteOrZero(playerB?.x);
  const ay = finiteOrZero(playerA?.y);
  const by = finiteOrZero(playerB?.y);
  const bodyHeight = Math.max(0, finiteOrZero(height));

  const dx = bx - ax;
  const aTop = ay + bodyHeight;
  const bTop = by + bodyHeight;
  let verticalGap = 0;

  if (aTop < by) {
    verticalGap = by - aTop;
  } else if (bTop < ay) {
    verticalGap = ay - bTop;
  }

  return dx * dx + verticalGap * verticalGap;
}

export function arePlayerBodiesWithinRange(playerA, playerB, range = PLAYER_COLLISION.tagRadius) {
  const tagRange = Math.max(0, finiteOrZero(range));
  return playerBodyDistanceSq(playerA, playerB) <= tagRange * tagRange;
}

export const MOTION_LINES_SPRITE = Object.freeze({
  asset: 'wind-motion-lines-sprite.png',
  frameWidth: 32,
  frameHeight: 20,
  frameCount: 8,
  scale: 1,
  alpha: 0.74,
});

export const TIMER_FONT = Object.freeze({
  glyphs: '0123456789:',
  pressureThresholdMs: 10_000,
  normal: Object.freeze({
    asset: 'timer-font-normal.png',
    cellWidth: 12,
    cellHeight: 16,
  }),
  pressure: Object.freeze({
    asset: 'timer-font-pressure.png',
    cellWidth: 14,
    cellHeight: 18,
  }),
});

export const PARTICLE_TUNING = Object.freeze({
  maxPuffs: 18,
  runIntervalMs: 125,
});

export const HEADBAND_PALETTE = Object.freeze([
  Object.freeze({
    id: 'electric-blue',
    label: 'Electric Blue',
    color: '#008CFF',
    asset: 'runner-electric-blue.png',
  }),
  Object.freeze({
    id: 'neon-green',
    label: 'Neon Green',
    color: '#00E85A',
    asset: 'runner-neon-green.png',
  }),
  Object.freeze({
    id: 'hot-pink',
    label: 'Hot Pink',
    color: '#FF2BBD',
    asset: 'runner-hot-pink.png',
  }),
  Object.freeze({
    id: 'sun-yellow',
    label: 'Sun Yellow',
    color: '#FFE500',
    asset: 'runner-sun-yellow.png',
  }),
  Object.freeze({
    id: 'orange',
    label: 'Orange',
    color: '#FF7A00',
    asset: 'runner-orange.png',
  }),
  Object.freeze({
    id: 'violet',
    label: 'Violet',
    color: '#8A2BFF',
    asset: 'runner-violet.png',
  }),
  Object.freeze({
    id: 'cyan',
    label: 'Cyan',
    color: '#00E5FF',
    asset: 'runner-cyan.png',
  }),
  Object.freeze({
    id: 'red',
    label: 'Red',
    color: '#FF1744',
    asset: 'runner-red.png',
  }),
]);

export const DEFAULT_HEADBAND = HEADBAND_PALETTE[0];

export function getHeadbandByIndex(index) {
  const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  const normalizedIndex = ((safeIndex % HEADBAND_PALETTE.length) + HEADBAND_PALETTE.length) % HEADBAND_PALETTE.length;
  return HEADBAND_PALETTE[normalizedIndex];
}

export function getHeadbandById(id) {
  return HEADBAND_PALETTE.find(headband => headband.id === id) || DEFAULT_HEADBAND;
}
