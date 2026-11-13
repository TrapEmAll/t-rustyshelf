// The walkable arcade's plan (shared/arcade-plan.js): packing, floor plan, residency, determinism. Pure: no Electron,
// DOM or THREE. Runs in plain Node.
'use strict';
const AP = require('../../shared/arcade-plan.js');
let failed = 0;
const check = (name, ok, detail) => { if (ok) console.log("ok   ", name); else { failed++; console.log("FAIL ", name, detail !== undefined ? " — " + detail : ""); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// a synthetic library: 3,000 arcade games across 5 genres, plus a no-genre one and a 1-game genre
const E = [];
for (let i = 0; i < 3000; i++) E.push({ id: 'a' + i, primaryGenre: ['Fighting', 'Racing', 'Puzzle', 'Shooter', 'Classic'][i % 5], sourceOrder: i });
E.push({ id: 'mystery', primaryGenre: null, sourceOrder: 3000 });
E.push({ id: 'solo', primaryGenre: 'Dancing', sourceOrder: 3001 });

{
  const p = AP.planArcade(E, { cap: 24 });
  check('rooms exist for every genre plus Unknown', p.rooms.some(r => r.genreKey === 'fighting') && p.rooms.some(r => r.genreKey === 'unknown'));
  check('a 1-game genre still gets a room', p.rooms.some(r => r.gameIds.includes('solo')));
  check('missing genre lands in the Unknown room', p.rooms.some(r => r.genreKey === 'unknown' && r.gameIds.includes('mystery')));
  check('no room exceeds the cap (24 default)', p.rooms.every(r => r.gameIds.length <= p.cap), Math.max(...p.rooms.map(r => r.gameIds.length)));
  check('rooms beyond the cap continue as signed wings', p.rooms.some(r => / · 2 of \d+$/.test(r.title)), p.rooms.map(r => r.title).slice(0, 6).join(' | '));
  const seen = new Set(); p.rooms.forEach(r => r.gameIds.forEach(id => { if (seen.has(id)) throw new Error('dup ' + id); seen.add(id); }));
  check('every eligible game occurs exactly once', seen.size === E.length, seen.size + ' of ' + E.length);
  check('locate() finds a game by id', eq(p.locate('a0'), p.byGame.get('a0')) && !!p.locate('a0'));
  check('the plan is deterministic across runs', (() => { const p2 = AP.planArcade(E.slice(), { cap: 24 }); return eq(p.rooms.map(r => [r.id, r.x, r.z, r.gameIds]), p2.rooms.map(r => [r.id, r.x, r.z, r.gameIds])); })());
  check('the floor plan: rooms alternate north/south of the corridor', p.rooms.slice(0, 4).map(r => r.z < 0).join() === 'true,false,true,false');
  check('every room door faces the corridor', p.rooms.every(r => Math.abs(Math.abs(r.door.z) - AP.CORRIDOR.w / 2) < .01));
  check('rooms do not overlap the corridor', p.rooms.every(r => Math.abs(r.z) - r.d / 2 >= AP.CORRIDOR.w / 2 - .2));
  check('rooms do not overlap each other', (() => { const bySide = [p.rooms.filter(r => r.z < 0), p.rooms.filter(r => r.z > 0)]; return bySide.every(side => side.every((r, i) => i === 0 || r.x - r.w / 2 > side[i - 1].x + side[i - 1].w / 2 - .01)); })());
  check('cabinet slots: one per game, inside the room', p.rooms.every(r => r.slots.length === r.gameIds.length && r.slots.every(s => Math.abs(s.x - r.x) < r.w / 2 && Math.abs(s.z - r.z) < r.d / 2)));
  check('slots keep walking clearance from the far wall', p.rooms.every(r => r.slots.every(s => Math.abs(s.z) - Math.abs(r.z) <= r.d / 2 - AP.CLEAR + .01)));
  check('the foyer has a museum door and a corridor door', !!p.museumDoor && !!p.foyerDoor && p.foyerDoor.x > p.foyer.x);
  check('the walls carry the foyer outline and room walls', p.walls.length > p.rooms.length);
  check('resident(±1) is exactly 3 rooms', p.resident(p.rooms[5].id, 1).size === 3);
  check('shuffled input: every game keeps its room and slot', (() => { const a = AP.planArcade(E, { cap: 24 }); const sh = E.slice().sort(() => Math.random() - .5); const b = AP.planArcade(sh, { cap: 24 });
    return E.every(e => { const la = a.locate(e.id), lb = b.locate(e.id); return la && lb && la.roomId === lb.roomId && la.slot === lb.slot; }); })());
  check('a 3,000-game plan plans in under 200 ms', (() => { const t0 = Date.now(); AP.planArcade(E, { cap: 24 }); return Date.now() - t0 < 200; })());
}
{
  // cap clamping: the renderer clamps the saved choice; the planner respects 20-30
  const E = []; for (let i = 0; i < 100; i++) E.push({ id: 'x' + i, primaryGenre: 'Fighting', sourceOrder: i });
  check('cap 30 is honored', AP.planArcade(E, { cap: 30 }).rooms.every(r => r.gameIds.length <= 30));
  check('cap 20 is honored', AP.planArcade(E, { cap: 20 }).rooms.every(r => r.gameIds.length <= 20));
  const small = AP.planArcade([{ id: 'only', primaryGenre: 'Racing' }], {});
  check('a one-game arcade is one room with one slot', small.rooms.length === 1 && small.rooms[0].slots.length === 1);
  const none = AP.planArcade([], {});
  check('an empty library plans zero rooms (the arcade just does not open)', none.rooms.length === 0);
  check('missing genre metadata: discoverable home', (() => { const p = AP.planArcade([{ id: 'n1', primaryGenre: null }], {}); return p.rooms.length === 1 && p.rooms[0].genreKey === 'unknown'; })());
}

{ // traversal: a player-radius circle crosses every doorway (the pure plan says so, before any rendering)
  const R = .34;
  const p = AP.planArcade(E, { cap: 24 });
  const blocked = (p, x, z) => p.walls.some(([x1, z1, x2, z2]) => {
    if (x1 === x2) { const lo = Math.min(z1, z2), hi = Math.max(z1, z2); return Math.abs(x - x1) < R && z > lo - R && z < hi + R; }
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2); return Math.abs(z - z1) < R && x > lo - R && x < hi + R; });
  p.doorways.forEach(d => {
    // the crossing: from 1 m outside to 1 m inside along the door's normal (ry 0 = +z south, π = −z north)
    const nz = d.ry === 0 ? 1 : -1;
    let crossed = true; for (let t = -1.4; t <= 1.4 && crossed; t += .1) { const x = d.x + Math.sin(d.ry) * 0 + 0, z = d.z + nz * t; if (blocked(p, x, z)) crossed = false; }
    check('doorway crossed: '+p.rooms.find(r => r.door.x === d.x && r.door.z === d.z).id, crossed);
  });
}
{ // the corridor boundaries: continuous, and blocked in both walking directions except at doorways
  const p2 = AP.planArcade(E, { cap: 24 });
  const blocked = (x, z) => p2.walls.some(([x1, z1, x2, z2]) => {
    if (x1 === x2) { const lo = Math.min(z1, z2), hi = Math.max(z1, z2); return Math.abs(x - x1) < .34 && z > lo - .34 && z < hi + .34; }
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2); return Math.abs(z - z1) < .34 && x > lo - .34 && x < hi + .34; });
  const corH = AP.CORRIDOR.w / 2;
  // walk the corridor's length at z=0 (inside): at every x between doors, stepping north or south must be blocked
  let open = 0; for (let x = p2.foyer.w / 2 + 1; x < p2.corridorEnd - 1; x += .5) {
    const atDoor = p2.doorways.some(d => Math.abs(d.x - x) < 1.3);
    if (!atDoor && (!blocked(x, -corH - .05) || !blocked(x, corH + .05))) open++;
  }
  check('the corridor edges block everywhere except doorways', open === 0, open + ' open spans');
}
console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
