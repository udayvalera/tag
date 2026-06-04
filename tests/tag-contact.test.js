import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_COLLISION,
  arePlayerBodiesWithinRange,
  playerBodyDistanceSq
} from '../public/game-config.js';

test('same-ground players tag within radius', () => {
  const tagger = { x: 100, y: 40 };
  const runner = { x: 100 + PLAYER_COLLISION.tagRadius - 1, y: 40 };

  assert.equal(arePlayerBodiesWithinRange(tagger, runner), true);
});

test('vertical body overlap tags when foot-point distance would miss', () => {
  const tagger = { x: 100, y: 40 };
  const runner = { x: 120, y: 65 };
  const footDx = runner.x - tagger.x;
  const footDy = runner.y - tagger.y;

  assert.equal(footDx * footDx + footDy * footDy > PLAYER_COLLISION.tagRadius ** 2, true);
  assert.equal(arePlayerBodiesWithinRange(tagger, runner), true);
});

test('clearly separated players do not tag', () => {
  const tagger = { x: 100, y: 40 };
  const runner = { x: 180, y: 120 };

  assert.equal(arePlayerBodiesWithinRange(tagger, runner), false);
});

test('body distance is horizontal distance when vertical segments overlap', () => {
  const tagger = { x: 100, y: 40 };
  const runner = { x: 125, y: 65 };

  assert.equal(playerBodyDistanceSq(tagger, runner), 25 ** 2);
});
