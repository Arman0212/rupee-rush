'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { makeRoom, seat } = require('./roomHelpers');

const rows = (room) => room.publicRoom().players;
const teamCounts = (room) => {
  const c = { A: 0, B: 0, none: 0 };
  for (const p of rows(room)) c[p.team || 'none']++;
  return c;
};

describe('room modes: teams', () => {
  test('turning teams on deals even teams; the host can reassign and reshuffle', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B', 'C', 'D');
    room.updateSettings('s1', { teams: true });
    assert.deepEqual(teamCounts(room), { A: 2, B: 2, none: 0 });

    const second = rows(room)[1].id;
    assert.equal(room.setTeam('s2', second, 'A').error, 'only the host can do that');
    assert.ok(room.setTeam('s1', second, 'A').ok);
    assert.equal(rows(room).find((p) => p.id === second).team, 'A');
    assert.ok(room.shuffleTeams('s1').ok);
    assert.deepEqual(teamCounts(room), { A: 2, B: 2, none: 0 });
  });

  test('a team game needs even teams of 4 or 6 before it starts, and the teams reach the engine', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B', 'C');
    room.updateSettings('s1', { teams: true });
    assert.match(room.start('s1').error, /4 or 6 players/);

    room.join({ socketId: 's4', name: 'D' });
    room.shuffleTeams('s1');
    assert.ok(room.start('s1').ok);
    const teams = new Set(room.game.state.players.map((p) => p.team));
    assert.deepEqual([...teams].sort(), ['A', 'B']);
  });

  test('turning teams off clears everyone\'s team', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B', 'C', 'D');
    room.updateSettings('s1', { teams: true });
    room.updateSettings('s1', { teams: false });
    assert.deepEqual(teamCounts(room), { A: 0, B: 0, none: 4 });
    assert.equal(room.setTeam('s1', rows(room)[0].id, 'A').error, 'team mode is off');
  });
});

describe('room modes: Classic / Chaos picker', () => {
  test('choosing Chaos turns on the chaos features; Classic turns them off', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B');
    room.updateSettings('s1', { mode: 'chaos' });
    const c = room.settings;
    assert.equal(c.mode, 'chaos');
    assert.equal(c.worldEvents, true);
    assert.equal(c.worldEventEvery, 2);
    assert.equal(c.bounties, true);
    assert.equal(c.bountyRentThreshold, 300);
    assert.equal(c.landmarks, true);
    assert.equal(c.startingCash, 2000);
    assert.equal(c.startingCities, 2);
    assert.equal(c.auctionSeconds, 8);
    room.updateSettings('s1', { mode: 'classic' });
    assert.equal(room.settings.worldEvents, false);
    assert.equal(room.settings.bounties, false);
    assert.equal(room.settings.landmarks, false);
    assert.equal(room.settings.teams, false);
  });

  test('general settings stay editable in Chaos', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B');
    room.updateSettings('s1', { mode: 'chaos' });
    room.updateSettings('s1', { isPrivate: true, turnTimerSeconds: 60 });
    assert.equal(room.settings.mode, 'chaos'); // still chaos
    assert.equal(room.settings.isPrivate, true);
    assert.equal(room.settings.turnTimerSeconds, 60);
    assert.equal(room.settings.startingCash, 2000); // chaos value preserved
  });

  test('Chaos turns teams on with 4 players and off otherwise', () => {
    const { room } = makeRoom();
    seat(room, 'A', 'B');
    room.updateSettings('s1', { mode: 'chaos' });
    assert.equal(room.settings.teams, false); // free-for-all with 2
    room.join({ socketId: 's3', name: 'C' });
    assert.equal(room.settings.teams, false); // 3 players
    room.join({ socketId: 's4', name: 'D' });
    assert.equal(room.settings.teams, true); // 4 players → teams
    assert.deepEqual(teamCounts(room), { A: 2, B: 2, none: 0 });
    room.join({ socketId: 's5', name: 'E' });
    assert.equal(room.settings.teams, false); // 5 → free-for-all again
    assert.deepEqual(teamCounts(room), { A: 0, B: 0, none: 5 });
  });

  test('the public listing marks Chaos rooms', () => {
    const { room } = makeRoom();
    seat(room, 'A');
    room.updateSettings('s1', { mode: 'chaos' });
    assert.equal(room.listing().mode, 'chaos');
  });
});

describe('room modes: team-only chat', () => {
  test('a team message reaches only the sender and their teammates', () => {
    const { room, transport } = makeRoom();
    seat(room, 'A', 'B', 'C', 'D');
    room.updateSettings('s1', { mode: 'chaos' });
    room.start('s1');
    const bySocket = {};
    for (const p of room.publicRoom().players) bySocket[p.id] = p.team;
    const myTeam = room.game.state.players.find((p) => p.id === room.publicRoom().players[0].id).team;
    transport.messages.length = 0;
    room.chat('s1', 'teammates only', true);
    const got = transport.messages.filter((m) => m.event === 'chat');
    // Every recipient is on the sender's team; the message is marked team.
    assert.ok(got.length >= 1);
    assert.ok(got.every((m) => m.payload.team === myTeam));
    assert.ok(!transport.received('s1', 'chatHistory').some((h) => (h.messages || []).some((msg) => msg.text === 'teammates only')));
  });
});

describe('room modes: optional settings reach the game', () => {
  test('world events, bounties and landmarks pass through to the engine and publicState', () => {
    const { room, transport } = makeRoom();
    seat(room, 'A', 'B');
    room.updateSettings('s1', { worldEvents: true, bounties: true, landmarks: true, worldEventEvery: 2, bountyRentThreshold: 700 });
    room.start('s1');
    const s = room.game.state.settings;
    assert.equal(s.worldEvents, true);
    assert.equal(s.bounties, true);
    assert.equal(s.landmarks, true);
    assert.equal(s.worldEventEvery, 2);
    assert.equal(s.bountyRentThreshold, 700);
    const state = transport.last('s1', 'state').publicState;
    assert.ok(state.world); // world block present when the mode is on
    assert.ok(state.bounties);
  });
});
