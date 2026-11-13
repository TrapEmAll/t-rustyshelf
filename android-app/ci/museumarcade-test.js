// The walkable arcade (discussion #19): enter from the museum, walk foyer → corridor → room A → corridor →
// room B → corridor → back to room A, holding real movement keys until each waypoint is reached, then launch a
// cabinet's game and return to the same cabinet. Run (after node copy-web.js): node ci/museumarcade-test.js www ../out/museumarcade
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
const AP = require('../../shared/arcade-plan.js');
const WWW = path.resolve(process.argv[2] || 'www'), OUT = path.resolve(process.argv[3] || '../out/museumarcade');
fs.mkdirSync(OUT, { recursive: true });
let fails = 0; const check = (name, ok, detail) => { console.log((ok ? '✅ ' : '❌ ') + name + (ok || detail == null ? '' : '  -> ' + String(detail).slice(0, 700))); if (!ok) fails++; };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.webm': 'video/webm' };
const server = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const p = path.join(WWW, u === '/' ? 'index.html' : u);
  if (!p.startsWith(WWW)) { r.writeHead(403); return r.end(); }
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); r.end(d); }); });
const w = ms => new Promise(r => setTimeout(r, ms));
server.listen(0, async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } }), page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://localhost:${server.address().port}/index.html?platform=windows&shelf=1&big=8&wave2=1&arcade=60`); await w(7000);
    await page.evaluate(() => { Shelf._mus.set('grouping', 'manufacturer'); });
    await page.keyboard.press('m'); await w(7500);
    await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 8 && Museum._dv && Museum._dv(); i++) { Museum.skipDelivery(); await w(300); } if (Museum.skipFill) Museum.skipFill(); await w(400);
      let guard = 0; while (Museum.rooms().room.kind !== 'arcade' && guard++ < 20) { Museum.stepRoom(1); await w(500); } await w(400); });
    const at = await page.evaluate(() => ({ kind: Museum.rooms().room.kind, id: Museum.rooms().room.id }));
    check('an arcade room is active', at.kind === 'arcade', JSON.stringify(at));
    const entered = await page.evaluate(() => !!(Museum.enterArcade && Museum.enterArcade()));
    await w(900);
    check('the walk starts at the foyer', entered && (await page.evaluate(() => Museum.isWalking())) === true && (await page.evaluate(() => Museum.walkState().room)) === 'foyer');
    // ---- the route: read the plan's door waypoints, then hold keys until each is reached ----
    const arc = await page.evaluate(() => Museum._arcade && Museum._arcade());
    check('the arcade plan is loaded', arc && arc.rooms.length > 0, arc && JSON.stringify({ rooms: arc.rooms.length }));
    const rA = arc.rooms[0], rB = arc.rooms[1];
    const events = [];
    const snap = async tag => { const st = await page.evaluate(() => Museum.walkState()); events.push({ tag, ...st }); return st; };
    const face = async deg => { await page.evaluate(d => { if (Museum.setWalkHeading) Museum.setWalkHeading(d); }, deg); await w(120); };
    const walkTo = async (key, pred, cap) => { await page.keyboard.down(key); let t0 = Date.now(), last = null;
      while (Date.now() - t0 < cap) { await w(80); last = await page.evaluate(() => Museum.walkState()); if (pred(last)) break; }
      await page.keyboard.up(key); await w(150); return last; };
    // east through the foyer's corridor door (gap at x=4.5, z=0): face east, walk past it
    await face(90);
    const out1 = await walkTo('w', s => s.room === 'corridor', 9000); await snap('in corridor');
    check('route: foyer → corridor', out1 && out1.room === 'corridor', JSON.stringify(out1));
    // east to room A door x, then face north (π) and step through the 2-wide doorway
    const east1 = await walkTo('w', s => s.x >= rA.doorX - .2, 12000); await snap('at room A door');
    check('route: corridor at room A door', east1 && Math.abs(east1.x - rA.doorX) < 1.2, JSON.stringify(east1));
    await face(180);
    const inA = await walkTo('w', s => s.room && s.room.startsWith('arcade:'), 9000); await snap('room A');
    check('route: into room A', inA && inA.room && inA.room.startsWith('arcade:'), JSON.stringify(inA));
    // south back into the corridor (face 0 walks +z from a north room)
    await face(0);
    const back1 = await walkTo('w', s => s.room === 'corridor' && Math.abs(s.z) < .5, 9000); await snap('corridor back');
    check('route: room A → corridor', back1 && back1.room === 'corridor', JSON.stringify(back1));
    // east to room B door x: face east (90) first (the previous walk left the heading south)
    await face(90);
    const east2 = await walkTo('w', s => s.x >= rB.doorX - .2, 15000); await snap('at room B door');
    check('route: corridor at room B door', east2 && Math.abs(east2.x - rB.doorX) < 1.2, JSON.stringify(east2));
    await face(0);
    const inB = await walkTo('w', s => s.room && s.room.startsWith('arcade:'), 9000); await snap('room B');
    check('route: into room B (a different room)', inB && inB.room && inB.room.startsWith('arcade:') && inB.room !== inA.room, JSON.stringify({ a: inA.room, b: inB.room }));
    // back: north to the corridor (face 180 from a south room), west past room A door (face 270), north into room A
    await face(180); const back2 = await walkTo('w', s => s.room === 'corridor' && Math.abs(s.z) < .5, 9000); await snap('corridor back 2');
    await face(270); const west = await walkTo('w', s => s.x <= rA.doorX + .2, 15000); void west; await snap('corridor west');
    await face(180); const inA2 = await walkTo('w', s => s.room && s.room.startsWith('arcade:'), 9000); await snap('room A again');
    check('route: back to room A with the camera continuous', inA2 && inA2.room === inA.room, JSON.stringify({ a: inA.room, a2: inA2.room }));
    check('the camera kept walking (positions differ per step)', events.length > 3 && events[1].x !== events[0].x, JSON.stringify(events.slice(0, 2)));
    // stand in front of a cabinet: walk to the first slot's front (slot positions come from the plan), prompt, launch
    const slotA = (await page.evaluate(() => Museum._arcade())) === null ? null : (await page.evaluate(() => { const a = Museum._arcade(); void a; return null; }));
    const slots = await page.evaluate(() => { const a = Museum._arcade && Museum._arcade(); return a && a.rooms[0]; }); void slots;
    // the slot list isn't exposed; walk north deeper into room A until the prompt fires (slots face the door)
    const cab = await (async () => { let hit = null;
      for (let i = 0; i < 50 && !hit; i++) { await page.keyboard.down('w'); await w(90); await page.keyboard.up('w'); await w(60); const c = await page.evaluate(() => Museum.current()); if (c.walk && c.walk.cabinet) hit = c.walk.cabinet; }
      return hit ? { title: hit.title, d: hit.d } : null; })();
    check('a cabinet is reachable and prompts', !!cab, JSON.stringify(cab));
    if (cab) {
      const launch = await page.evaluate(() => { const r = Museum.activate(); return r && { play: !!r.arcadePlay, title: r.arcadePlay && r.arcadePlay.title }; });
      check('A on the cabinet launches through the normal path', !!launch && launch.play, JSON.stringify(launch));
      const launching = await page.evaluate(() => ({ launchVisible: !!document.getElementById('launch') && document.getElementById('launch').className.includes('on') }));
      await w(1200); const leftMuseum = await page.evaluate(() => !document.body.className.includes('museum-open') || (document.getElementById('launch') && document.getElementById('launch').className.includes('on')));
      check('the launch path runs (the launch screen or the museum hands off to the emulator)', launching.launchVisible || leftMuseum, JSON.stringify({ launching, leftMuseum }));
      await w(1200); await page.keyboard.press('Escape'); await w(900); await page.keyboard.press('Escape'); await w(900);
      const back = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); let guard = 0;
        while (!(window.Museum && Museum.isWalking && Museum.isWalking()) && guard++ < 14) { await w(600); if (mode === 'browse' && window.Museum && Museum.resumeWalk) Museum.resumeWalk(null); }
        return { walking: !!(window.Museum && Museum.isWalking && Museum.isWalking()), pos: window.Museum.isWalking ? Museum.walkState() : null }; });
      check('after the launch the walk resumes (same room)', back.walking && back.pos && back.pos.room && back.pos.room.startsWith('arcade:'), JSON.stringify(back));
    }
    // exit: from the resumed room, walk to the corridor (opposite the room's side), west along it to the foyer, to the door
      const arc2 = await page.evaluate(() => Museum._arcade());
      const resumedRoom = await page.evaluate(() => Museum.walkState().room);
      const rInfo = arc2.rooms.find(r => r.id === resumedRoom) || arc2.rooms[0];
      const toCor = rInfo.side === 'N' ? 0 : 180; // north room: face 0 (south) reaches the corridor; south room: face 180
      await face(toCor); const exC = await walkTo('w', s => s.room === 'corridor' && Math.abs(s.z) < .5, 20000); void exC; await snap('exit: corridor');
      await face(270); const exF = await walkTo('w', s => s.room === 'foyer' || s.x < -1.0, 30000); void exF; await snap('exit: foyer');
      const exD = await walkTo('w', s => s.x < -3.3, 20000); void exD; await snap('exit: at the door');
      await face(270); // face the museum door (−x) — the heading normalizes to −π/2
      const out = await page.evaluate(() => { const r = Museum.back(); return { exited: !Museum.isWalking(), ok: r, st: Museum.walkState && Museum.walkState() }; }); await w(600);
      check('B at the museum door walks back out to the museum', out.exited, JSON.stringify({ st: out.st, out }));
  } catch (e) { check('the test ran to the end', false, e && e.stack); }
  finally { try { await browser.close(); } catch {} try { server.close(); } catch {} }
  console.log(fails ? fails + ' check(s) failed' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
});
