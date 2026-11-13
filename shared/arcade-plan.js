// Arcade floor planning, shared by the renderer, the main process' tests and Android: a pure module with no Electron,
// DOM or THREE in it. Given the arcade's games as plain entries ({ id, primaryGenre, sourceOrder }), it packs them into
// genre rooms (deterministic, stable ids, every game exactly once) and lays the rooms out on a walkable floor plan —
// a foyer with the museum door at one end, an east–west corridor, and rooms opening off it on both sides, so the player
// walks out of one room, across the corridor, and into another without a loading screen. Same shape as
// shared/museum-layout.js; BSMuseumLayout.classify-style rules live there (this module only plans the arcade wing).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BSArcadePlan = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // A room holds at most ROOM_CAP cabinets (discussion #19's 20–30 range; the renderer clamps the saved choice).
  // Overflow continues into signed wings ("Fighting · 2 of 3"), never truncation.
  const ROOM_CAP = 24, CAP_MIN = 20, CAP_MAX = 30;
  // Floor-plan dimensions (world units; the museum's case is 1 unit tall, eye level is 1.6).
  const FOYER = { w: 9, d: 7 };          // the foyer: museum door at -x, corridor door at +x
  const CORRIDOR = { w: 4.2 };           // corridor width (east–west, z ∈ [-w/2, w/2])
  const ROOM = { w: 12.5, d: 9.5 };      // one genre room's interior
  const GAP = 2.4;                       // wall thickness + gap between rooms along the corridor
  const CABINET = { w: .78, d: .86 };    // a floor-standing cabinet's footprint
  const CLEAR = 1.15;                    // walking clearance kept between cabinet rows and walls

  function genreKeyOf(primaryGenre) {
    const s = String(primaryGenre == null ? '' : primaryGenre).trim();
    return s ? s.toLowerCase().replace(/\s+/g, ' ') : 'unknown';
  }
  function genreLabel(key, primary) { const s = String(primary == null ? '' : primary).trim(); return s ? s : 'Unknown'; }

  // rooms: [{ id, groupKey, genreKey, title, part, parts, gameIds, cap }]
  // plan:  { foyer, corridorEnd, rooms: [{ id, x, z, w, d, door: { x, z, ry }, slots: [{ x, z, ry, kind }] }],
  //          walls: [ [x1, z1, x2, z2] ] — solid wall segments for collision (doorways left out),
  //          doorways: [ [x, z, ry] ], byGame: Map gameId → { roomId, slot }
  // Rooms alternate north (z < 0) and south (z > 0) of the corridor; the foyer sits at the corridor's west end, the
  // museum door in its -x wall. Everything is axis-aligned, so collision is simple segment lists.
  function planArcade(entries, opts) {
    const cap = Math.max(CAP_MIN, Math.min(CAP_MAX, Math.round((opts && opts.cap) || ROOM_CAP) || ROOM_CAP));
    const list = (entries || []).filter(Boolean);
    // ---- pack: genres in name order (Unknown last), games in source order, rooms of ≤ cap, signed continuations ----
    const byGenre = new Map(), order = [];
    list.forEach(e => {
      const gk = genreKeyOf(e.primaryGenre);
      let g = byGenre.get(gk);
      if (!g) { g = { gk, games: [] }; byGenre.set(gk, g); order.push(g); }
      g.games.push(e);
    });
    // canonical order: by game id (a rescan or a shuffled source must not move a game between rooms or slots);
    // sourceOrder breaks ties only for the same id (which cannot happen in practice)
    order.forEach(g => g.games.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }) || (a.sourceOrder || 0) - (b.sourceOrder || 0)));
    order.sort((a, b) => (a.gk === 'unknown') - (b.gk === 'unknown') || a.gk.localeCompare(b.gk));
    const rooms = [];
    order.forEach(g => {
      const n = Math.ceil(g.games.length / cap);
      for (let k = 0; k < n; k++) {
        const slice = g.games.slice(k * cap, (k + 1) * cap);
        rooms.push({
          id: `arcade:${g.gk}:${k}`, groupKey: 'arcade', genreKey: g.gk,
          title: (n > 1 ? `${genreLabel(g.gk)} · ${k + 1} of ${n}` : genreLabel(g.gk)),
          plain: genreLabel(g.gk), gameIds: slice.map(e => String(e.id)), cap
        });
      }
    });
    // ---- floor plan: foyer at the west end, corridor east, rooms alternating north/south ----
    const foyer = { x: 0, z: 0, w: FOYER.w, d: FOYER.d }; // centre (0,0); museum door at x=-w/2, corridor door at +x
    const corH = CORRIDOR.w / 2;
    const placed = [];
    let x = foyer.w / 2 + ROOM.d / 2 + 1.4; // the first room's door clears the foyer's corridor door
    rooms.forEach((r, i) => {
      const north = (i % 2 === 0); // alternate sides so crossing the corridor is always the move
      const cx = x, cz = north ? -(corH + ROOM.d / 2 + .12) : (corH + ROOM.d / 2 + .12);
      const door = { x: cx, z: north ? -corH : corH, ry: north ? 0 : Math.PI }; // the doorway on the corridor side
      placed.push(Object.assign(r, { x: cx, z: cz, w: ROOM.w, d: ROOM.d, door }));
      x += ROOM.d + GAP; // rooms stand side by side along the corridor (their width spans x)
    });
    const corridorEnd = x - ROOM.d / 2 - 1; // where the corridor's far (east) wall stands
    // ---- cabinet slots per room: uprights along the back wall and side walls, facing the door ----
    // kinds: 'upright' (most genres), 'sitdown' (racing), 'cocktail' (puzzle & classics), 'pedestal' (fighting: open floor)
    placed.forEach(r => {
      const kindOf = /racing|driving/.test(r.genreKey) ? 'sitdown' : /fight|beat|brawler/.test(r.genreKey) ? 'pedestal' : /puzzle|classic|breakout|arkanoid/.test(r.genreKey) ? 'cocktail' : 'upright';
      r.cabinetKind = kindOf;
      const slots = [];
      const zBack = r.z + (r.z < 0 ? -(r.d / 2 - CLEAR) : (r.d / 2 - CLEAR)); // against the room's far wall
      const backRy = r.z < 0 ? Math.PI : 0; // (north room: the screen turns +z, toward the corridor)
      const inner = r.w - 2 * CLEAR, n = r.gameIds.length;
      const cols = Math.max(1, Math.min(Math.ceil(n / 2), Math.floor(inner / (CABINET.w + .55)))); // cabinets per row that fit
      const rows = Math.ceil(n / cols), along = inner / cols;
      for (let i = 0; i < n; i++) {
        const row = Math.floor(i / cols), k = i % cols, rowN = Math.min(cols, n - row * cols);
        const sx = r.x - inner / 2 + along * (k + .5) + (row % 2 ? along / 2 : 0);
        const sz = zBack + (row % 2 ? (r.z < 0 ? CABINET.d + .35 : -CABINET.d - .35) : 0) * Math.floor(row / 2); // (rows step toward the door)
        slots.push({ x: +sx.toFixed(3), z: +sz.toFixed(3), ry: backRy, kind: kindOf });
      }
      r.slots = slots;
    });
    // ---- walls for collision + the doorway list (walk collision uses these; doorways are gaps) ----
    const doorways = placed.map(r => r.door);
    const walls = [];
    const seg = (x1, z1, x2, z2) => walls.push([+x1.toFixed(2), +z1.toFixed(2), +x2.toFixed(2), +z2.toFixed(2)]);
    // foyer: three solid sides + its corridor door gap (1.6 wide) on the east side
    const fw = foyer.w / 2, fd = foyer.d / 2, DG = 1.6;
    seg(-fw, -fd, -fw, fd);                       // museum door wall (west)
    seg(-fw, -fd, fw - DG / 2, -fd); seg(fw - DG / 2, fd, -fw, fd); // north + south, door gap on the east side
    seg(fw, -fd, fw, -DG / 2); seg(fw, DG / 2, fw, fd);            // east wall either side of the corridor door
    // the corridor: CONTINUOUS north and south walls from the foyer to the east end, with a gap at each doorway —
    // nothing between doorways is open, so the player can never walk off the floor
    [[-corH, placed.filter(r => r.z < 0)], [corH, placed.filter(r => r.z > 0)]].forEach(([s, side]) => {
      const gaps = side.map(r => [r.door.x - DG / 2, r.door.x + DG / 2]).sort((a, b) => a[0] - b[0]);
      let x = foyer.w / 2; gaps.forEach(([g0, g1]) => { if (g0 > x) seg(x, s, g0, s); x = Math.max(x, g1); });
      if (x < corridorEnd) seg(x, s, corridorEnd, s);
    });
    seg(corridorEnd, -corH, corridorEnd, corH); // the corridor's east end
    // room walls (each room's own outline, with the doorway side open): far wall, two sides, and the jambs of the door
    placed.forEach(r => {
      const hw = r.w / 2, hd = r.d / 2, cx = r.x, cz = r.z;
      const dg = DG, dsZ = r.z < 0 ? cz + hd : cz - hd, pw = (r.w - dg) / 2;
      seg(cx - r.w / 2, dsZ, r.door.x - dg / 2, dsZ); seg(r.door.x + dg / 2, dsZ, cx + r.w / 2, dsZ); void pw;
      seg(cx - hw, r.z < 0 ? cz - hd : cz + hd, cx + hw, r.z < 0 ? cz - hd : cz + hd); // far wall (back, away from the corridor)
      const dsY = r.z < 0 ? cz + hd : cz - hd; // the doorway side's line
      seg(cx - hw, cz - hd, cx - hw, dsY); seg(cx + hw, cz - hd, cx + hw, dsY); // side walls, from the back to the doorway line
    });
    // byGame: where each game lives (selection restore by game id — never by room ordinal)
    const byGame = new Map();
    placed.forEach(r => r.gameIds.forEach((id, i) => byGame.set(id, { roomId: r.id, slot: i })));
    const locate = gameId => byGame.get(String(gameId)) || null;
    // resident set: the room the player is in, ±radius along the plan order (plus the foyer/corridor spine, always on)
    function resident(roomId, radius) {
      const i = placed.findIndex(r => r.id === roomId);
      const out = new Set();
      for (let k = Math.max(0, i - radius); k <= Math.min(placed.length - 1, i + radius); k++) out.add(placed[k].id);
      return out;
    }
    return {
      cap, rooms: placed, foyer, corridorEnd, walls, doorways,
      byGame, locate, resident,
      museumDoor: { x: -fw, z: 0, ry: -Math.PI / 2 },
      foyerDoor: { x: fw - DG / 2, z: 0, ry: Math.PI / 2 }
    };
  }

  return { ROOM_CAP, CAP_MIN, CAP_MAX, planArcade, genreKeyOf, CABINET, CLEAR, FOYER, CORRIDOR, ROOM };
});
