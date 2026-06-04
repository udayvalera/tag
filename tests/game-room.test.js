import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom, TAG_SEPARATION_RADIUS } from '../game-room.js';

function createRunningRoom() {
  const events = [];
  const room = new GameRoom('TEST01', (event, payload) => {
    events.push({ event, payload });
  });
  room.addPlayer({ id: 'it' }, 'It');
  room.addPlayer({ id: 'runner' }, 'Runner');

  const now = Date.now();
  room.state = 'running';
  room.gameStartAt = now - 1000;
  room.gameEndsAt = now + 60_000;
  room.setTagger('it');
  room.players.get('it').x = 100;
  room.players.get('it').y = 40;
  room.players.get('runner').x = 180;
  room.players.get('runner').y = 40;

  return { room, events };
}

function accept(room, id, state, seq = 1) {
  const player = room.players.get(id);
  player.lastAcceptedStateAt = 0;
  return room.acceptPlayerState(id, {
    x: state.x,
    y: state.y,
    vx: state.vx ?? 0,
    vy: state.vy ?? 0,
    dir: state.dir ?? 1,
    grounded: state.grounded ?? true,
    seq
  });
}

function tagEvents(events) {
  return events.filter(event => event.event === 'tag');
}

test('stationary IT tags when runner moves into contact', () => {
  const { room, events } = createRunningRoom();

  accept(room, 'runner', { x: 100, y: 40 });

  assert.equal(room.taggerId, 'runner');
  assert.deepEqual(tagEvents(events).map(event => event.payload), [{
    taggerId: 'runner',
    taggedById: 'it',
    serverTime: tagEvents(events)[0].payload.serverTime
  }]);
});

test('runner walking over stationary IT tags with body overlap', () => {
  const { room, events } = createRunningRoom();

  accept(room, 'runner', { x: 120, y: 65 });

  assert.equal(room.taggerId, 'runner');
  assert.equal(tagEvents(events).length, 1);
  assert.equal(tagEvents(events)[0].payload.taggedById, 'it');
});

test('moving IT tags the nearest overlapping runner', () => {
  const { room, events } = createRunningRoom();

  room.players.get('runner').x = 120;
  room.players.get('runner').y = 65;
  accept(room, 'it', { x: 100, y: 40 });

  assert.equal(room.taggerId, 'runner');
  assert.equal(tagEvents(events).length, 1);
});

test('blocked pair cannot tag back until body separation clears the block', () => {
  const { room, events } = createRunningRoom();

  accept(room, 'runner', { x: 100, y: 40 }, 1);
  assert.equal(room.taggerId, 'runner');
  assert.equal(tagEvents(events).length, 1);

  accept(room, 'it', { x: 100, y: 40 }, 1);
  assert.equal(room.taggerId, 'runner');
  assert.equal(tagEvents(events).length, 1);

  accept(room, 'it', { x: 100 + TAG_SEPARATION_RADIUS + 1, y: 40 }, 2);
  assert.equal(room.taggerId, 'runner');
  assert.equal(tagEvents(events).length, 1);

  accept(room, 'it', { x: 100, y: 40 }, 3);
  assert.equal(room.taggerId, 'it');
  assert.equal(tagEvents(events).length, 2);
});

test('auto tag does not run outside active game time or running state', () => {
  for (const state of ['waiting', 'countdown', 'ended']) {
    const { room, events } = createRunningRoom();
    room.state = state;

    accept(room, 'runner', { x: 100, y: 40 });

    assert.equal(room.taggerId, 'it');
    assert.equal(tagEvents(events).length, 0);
  }

  const { room, events } = createRunningRoom();
  const now = Date.now();
  room.gameStartAt = now + 1000;
  room.gameEndsAt = now + 2000;

  accept(room, 'runner', { x: 100, y: 40 });

  assert.equal(room.taggerId, 'it');
  assert.equal(tagEvents(events).length, 0);
});
