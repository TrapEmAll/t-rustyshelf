#!/usr/bin/env node
// (T)rustyShelf: every test, all at once. One command runs what used to be run by hand, one suite after another (about half an
// hour), at the same time on this PC: it takes as long as the slowest part (a device group, a few minutes) instead of the sum.
//
//   node scripts/test-all.js                 everything (the app is built unpacked first: a few seconds; the AppImage is built beside the
//                                            others, for the one suite that checks the AppImage itself)
//   node scripts/test-all.js --only node,desktop       only some kinds: node, desktop, demo, device
//   node scripts/test-all.js --skip-build    reuse the builds in dist/ts-unpacked and dist/ts-appimage as they are (nothing in the app changed)
//   node scripts/test-all.js --jobs 6        how many run at the same time (default 8)
//   node scripts/test-all.js --list          what would run, and nothing else
//   node scripts/test-all.js --quiet         only failures and the totals (no line for each job that passed)
//   node scripts/test-all.js --changed       only what the changes can affect: the files changed since what's pushed (and what isn't
//                                            committed yet), each mapped to the tests that cover it (it prints why); for each change
//                                            on its way. The full run is for releases. --changed <commit>: since that commit instead
//
// The kinds (nothing is left out, and a test file this script doesn't know is reported, so a new test can't be forgotten):
//   node     linux/ci/*-test.js that need no app: the backend pieces, run on made-up folders
//   desktop  linux/ci/*-test.js that start the real app on a virtual screen: the unpacked build (APPIMAGE set, so the app acts as
//            from an AppImage), and app-test on the real AppImage (it checks what only the AppImage has: its name in Steam's
//            shortcut, the wrapper's --no-sandbox and X11 options)
//   demo     android-app/ci/*-test.js that drive the demo page on their own
//   device   android-app/ci/web-device-test.js in seven parts of about the same length (thor, thor2, thor3, screens, screens2,
//            windows, windows2), run at the same time
// Each job's output is in linux-test-out/all/<name>.log. The exit code is 1 when a check fails that isn't in KNOWN.
//
// It runs under a memory cap (systemd-run, when there is one: --cap 12G) and at a lower priority, and every job's processes are
// stopped when it ends, so nothing is left running.
'use strict';
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = n => { const i = process.argv.indexOf('--' + n); return i < 0 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const only = arg('only') && arg('only') !== true ? String(arg('only')).split(',') : null;
const QUIET = !!arg('quiet');
const JOBS = Math.max(1, +arg('jobs') || 8), CAP = arg('cap') && arg('cap') !== true ? String(arg('cap')) : '12G';

// the tests, by kind (the first of each is the slowest: they start first)
const NODE = ['detect', 'gamewatch', 'taskbar', 'pad', 'portable', 'dataexport', 'release-version', 'presence', 'epicdl', 'storage', 'windowmode', 'hoyoplay', 'music', 'looks', 'artmatch', 'fork-survey', 'addgames', 'ra-consoles', 'ytsearch', 'archive-speed', 'emu-names', 'screenscraper', 'retroarch-setting', 'museum-lighting', 'museum-layout', 'arcade-plan', 'pc-boxart', 'switch-files', 'quiver', 'pc-console-plat', 'pcsx2-ra', 'pcfolder-async', 'steam-async', 'nup-build', 'xemu-detect', 'xbox-games', 'raportable', 'gamelist', 'pcach', 'vdf'];
const DESKTOP = ['app', 'pc', 'xbox', 'home', 'music-app', 'windowmode-app', 'epicdl-app', 'consolebox-app', 'artmatch-app', 'ngp', 'gamecom', 'vita', 'keepawake', 'emuchoice', 'export-app', 'artcheck'];
const DEMO = ['lamppool', 'caseinside', 'dscase', 'museumwrap', 'museumrooms', 'museumarcade', 'sortdrag', 'artresume', 'boxcolor', 'padfeed', 'android-artcard', 'android-pc', 'usermusic', 'windowmode', 'looks', 'artmatch', 'padnote', 'fanlift', 'media', 'bootvolume', 'pcach', 'cardboard', 'find', 'seamless'];
const GROUPS = ['screens', 'screens2', 'windows', 'thor3', 'thor2', 'thor', 'windows2']; // (the device test's seven parts, longest first: each 1.5-3.5 minutes)
// not tests of their own: run by a device group, or a probe
const NOT_STANDALONE = new Set(['heat-probe.js', 'web-device-test.js', 'device-test-parallel.js', 'museum-bench.js']); // (the bench: measurements, not assertions)
// checks that failed before and are known (printed as known, they don't fail the run)
// what a test harness says when its browser didn't start (under load), not a check that failed: the job runs once more
const HARNESS = /Unable to capture screenshot|Target page, context or browser has been closed|browserType\.launch: |Navigation timeout of \d+ ms exceeded|No such process/;
const KNOWN = []; // (the Thor's museum-companion check passes since the missing 3D PC model is no longer asked for)

// Tests run fully in the background (asked for 2026-11-12): no window on the desktop in use, no crash report. A test that
// sends SIGTERM to the app's whole process group makes its main process abort, so every run raised dozens of "crashed"
// notifications; one that starts a browser with headless: false shows a window. Either one stops the run before it starts.
function noisy() {
  const out = [];
  for (const [dir, f] of [...fs.readdirSync(path.join(ROOT, 'linux', 'ci')).map(f => ['linux/ci', f]), ...fs.readdirSync(path.join(ROOT, 'android-app', 'ci')).map(f => ['android-app/ci', f])]) {
    if (!/\.js$/.test(f)) continue; const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
    if (/process\.kill\(\s*-[^,]+,\s*['"]SIGTERM['"]/.test(src)) out.push(`${dir}/${f}: SIGTERM to the app's process group (send it to the main process, app.pid, then SIGKILL the group)`);
    if (/headless\s*:\s*false/.test(src)) out.push(`${dir}/${f}: a browser with headless: false (it opens a window on the desktop)`);
  }
  return out;
}
function unlisted() { // test files this script doesn't know
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'linux', 'ci'))) if (/-test\.js$/.test(f) && ![...NODE, ...DESKTOP].includes(f.replace(/-test\.js$/, ''))) out.push('linux/ci/' + f);
  for (const f of fs.readdirSync(path.join(ROOT, 'android-app', 'ci'))) {
    if (!/\.js$/.test(f) || NOT_STANDALONE.has(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, 'android-app', 'ci', f), 'utf8');
    if (/server\.listen\(/.test(src) && !/module\.exports/.test(src) && !DEMO.includes(f.replace(/-test\.js$/, ''))) out.push('android-app/ci/' + f);
  }
  return out;
}

// ---- --changed: the files changed, and the tests that cover them ----
function changedFiles(base) {
  const git = a => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return null; } };
  let b = base && base !== true ? String(base) : null;
  if (!b) { const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']); b = up && up[0] ? up[0] : 'HEAD'; } // (not pushed yet: since the branch's remote)
  const diff = git(['diff', '--name-only', b]); if (diff === null) return null; // (committed since then, and the working tree)
  return { base: b, files: [...new Set([...diff, ...(git(['ls-files', '--others', '--exclude-standard']) || [])])] };
}
function passGroups() { // android-app/ci/<pass>.js → the device group that requires it
  const out = {}; let g = null;
  try { for (const l of fs.readFileSync(path.join(ROOT, 'android-app', 'ci', 'web-device-test.js'), 'utf8').split('\n')) {
    const m = /if \(runs\('([a-z0-9]+)'\)\)/.exec(l); if (m) g = m[1];
    const r = /require\('\.\/([\w-]+)'\)/.exec(l); if (r && g) out[r[1]] = g; } } catch {}
  return out;
}
function changedPlan(files) {
  const kinds = new Set(), named = new Set(), why = [], groups = passGroups();
  const say = (f, what) => why.push(`  ${f} → ${what}`);
  for (const f of files) {
    let m;
    if ((m = /^linux\/ci\/(.+)-test\.js$/.exec(f)) && [...NODE, ...DESKTOP].includes(m[1])) { named.add(m[1] + '-test'); say(f, 'that test'); continue; }
    if (/^android-app\/ci\/[^/]*\.(yml|sh|bat)$/.test(f)) { say(f, 'nothing (a CI setting, not the app\'s code)'); continue; }
    if ((m = /^android-app\/ci\/([\w-]+)\.js$/.exec(f))) {
      const t = m[1].replace(/-test$/, '');
      if (DEMO.includes(t)) { named.add('demo-' + t); say(f, 'that test'); continue; }
      if (m[1] === 'web-device-test') { kinds.add('device'); say(f, 'every device group'); continue; }
      if (groups[m[1]]) { named.add('device-' + groups[m[1]]); say(f, `the device group that runs it (${groups[m[1]]})`); continue; }
      say(f, 'nothing (not a test that runs on its own)'); continue;
    }
    if (/^(main\.js|main\/|preload[\w-]*\.js$|shared\/)/.test(f)) { kinds.add('node'); kinds.add('desktop'); say(f, 'node and desktop (the desktop app\'s own code)'); continue; }
    if (/^renderer\//.test(f)) { kinds.add('desktop'); kinds.add('demo'); kinds.add('device'); say(f, 'desktop, demo and device (the screen, shared by every app)'); continue; }
    if (/^android-app\//.test(f)) { kinds.add('demo'); kinds.add('device'); say(f, 'demo and device (the Android app)'); continue; }
    if (f === 'scripts/test-all.js') { kinds.add('node'); say(f, 'node (a short run of this runner itself)'); continue; }
    if (f === 'scripts/release-version.js') { named.add('release-version-test'); say(f, 'release-version-test'); continue; }
    if (/^scripts\/(fork-survey|credits|release-notes)\.js$/.test(f)) { named.add('fork-survey-test'); say(f, 'fork-survey-test'); continue; }
    if (/^package(-lock)?\.json$/.test(f)) { ['node', 'desktop', 'demo', 'device'].forEach(k => kinds.add(k)); say(f, 'everything (the app\'s packages and version)'); continue; }
    if (/^(\.github\/|android-app\/ci\/[^/]*\.(yml|sh|bat)$|android-app\/ci\/fixtures\/README|scripts\/(community-report|push-build)\.js$|start-trustyshelf\.sh$|\.gitignore$|LICENSE|[^/]*\.(md|txt|bat)$)/.test(f)) { say(f, 'nothing (not the app\'s code)'); continue; }
    ['node', 'desktop', 'demo', 'device'].forEach(k => kinds.add(k)); say(f, 'everything (not known to this script: to be safe)');
  }
  return { kinds, named, why };
}

const logDir = path.join(ROOT, 'linux-test-out', 'all');
const UNPACKED = path.join(ROOT, 'dist', 'ts-unpacked'), APPIMAGE_DIR = path.join(ROOT, 'dist', 'ts-appimage'); // (their own folders: the usual dist/ is left alone)
const exe = path.join(UNPACKED, 'linux-unpacked', 'trustyshelf');
const appImage = () => { try { return fs.readdirSync(APPIMAGE_DIR).filter(f => /\.AppImage$/.test(f)).map(f => path.join(APPIMAGE_DIR, f))[0] || ''; } catch { return ''; } };
const jobs = [];
const add = (kind, name, cmd, args, o = {}) => { if (!only || only.includes(kind)) jobs.push({ kind, name, cmd, args, cwd: o.cwd || ROOT, env: o.env || {}, wait: o.wait || [] }); };
for (const g of GROUPS) add('device', 'device-' + g, process.execPath, ['ci/web-device-test.js', 'www', path.join(ROOT, 'out', 'all-' + g), '--group=' + g], { cwd: path.join(ROOT, 'android-app'), wait: ['web'], env: { GITHUB_STEP_SUMMARY: '' } });
for (const t of DESKTOP) { // (app-test on the real AppImage, the others on the unpacked build; the AppImage's path is filled in when it is built)
  if (t === 'app') add('desktop', t + '-test', 'xvfb-run', ['-a', process.execPath, path.join('linux', 'ci', t + '-test.js'), '@APPIMAGE@'], { wait: ['appimage'] });
  else add('desktop', t + '-test', 'xvfb-run', ['-a', process.execPath, path.join('linux', 'ci', t + '-test.js'), exe], { wait: ['app'], env: { APPIMAGE: exe } }); }
for (const t of DEMO) add('demo', 'demo-' + t, process.execPath, ['ci/' + t + '-test.js', 'www', path.join(ROOT, 'out', 'all-' + t)], { cwd: path.join(ROOT, 'android-app'), wait: ['web'] });
for (const t of NODE) add('node', t + '-test', process.execPath, [path.join('linux', 'ci', t + '-test.js')]);

const CHANGED = arg('changed');
if (CHANGED) {
  const c = changedFiles(CHANGED); if (!c) { console.log('--changed: git could not say what changed'); process.exit(2); }
  const pl = changedPlan(c.files), keep = jobs.filter(j => pl.kinds.has(j.kind) || pl.named.has(j.name));
  console.log(`--changed: ${c.files.length} file${c.files.length === 1 ? '' : 's'} changed since ${c.base}`); for (const w of pl.why) console.log(w);
  jobs.length = 0; jobs.push(...keep);
  if (!jobs.length) { console.log('Nothing to test for these changes.'); process.exit(0); }
}
if (arg('list')) { for (const j of jobs) console.log(`${j.kind.padEnd(8)} ${j.name}`); const u = unlisted(); if (u.length) console.log('NOT IN THE LISTS:', u.join(', ')); process.exit(0); }

// run under a memory cap and a lower priority, once (when systemd can do that for this user)
if (!process.env.TS_TEST_ALL_CAPPED && process.platform === 'linux' && spawnSync('systemd-run', ['--user', '--scope', '-q', '-p', 'MemoryMax=' + CAP, 'true'], { stdio: 'ignore' }).status === 0) {
  const r = spawnSync('systemd-run', ['--user', '--scope', '-q', '-p', 'MemoryMax=' + CAP, 'nice', '-n', '5', process.execPath, __filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, TS_TEST_ALL_CAPPED: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

const sh = (cmd, args, cwd) => new Promise(res => { const p = spawn(cmd, args, { cwd, stdio: 'ignore' }); p.on('close', c => res(c)); p.on('error', () => res(-1)); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(), secs = t => ((Date.now() - t) / 1000).toFixed(0) + 's';
const running = new Set(), results = [];
process.on('exit', () => { for (const p of running) try { process.kill(-p.pid, 'SIGKILL'); } catch {} });
process.on('SIGINT', () => process.exit(130)); process.on('SIGTERM', () => process.exit(143));

(async () => {
  fs.mkdirSync(logDir, { recursive: true });
  const u = unlisted(); if (u.length) console.log('WARNING: tests this script does not know (add them to its lists): ' + u.join(', '));
  const nz = noisy(); if (nz.length) { console.log('STOPPED: these would show up on the desktop while the tests run:\n  ' + nz.join('\n  ')); process.exit(1); }
  const needApp = jobs.some(j => j.wait.includes('app')), needWeb = jobs.some(j => j.wait.includes('web')), needImg = jobs.some(j => j.wait.includes('appimage'));
  const ready = { app: !needApp, web: !needWeb, appimage: !needImg };
  const build = (what, args, out) => sh('npx', ['electron-builder', '--linux', ...args, '--publish', 'never', '--config.directories.output=' + out], ROOT);
  // the preparations run beside the first jobs (the node tests need none of them)
  const prep = [];
  if (needApp) prep.push((async () => {
    const t = Date.now();
    if (arg('skip-build') && fs.existsSync(exe)) console.log('app: unpacked build reused');
    else { const c = await build('unpacked', ['dir'], UNPACKED); if (c !== 0 || !fs.existsSync(exe)) { console.log('app: the unpacked build failed (npx electron-builder --linux dir)'); process.exit(2); } console.log(`app: built unpacked in ${secs(t)}`); }
    ready.app = true; })());
  if (needImg) prep.push((async () => {
    const t = Date.now();
    if (arg('skip-build') && appImage()) console.log('AppImage: reused');
    else { try { fs.rmSync(APPIMAGE_DIR, { recursive: true, force: true }); } catch {} const c = await build('AppImage', ['AppImage'], APPIMAGE_DIR); if (c !== 0 || !appImage()) { console.log('AppImage: the build failed (npx electron-builder --linux AppImage)'); process.exit(2); } console.log(`AppImage: built in ${secs(t)}`); }
    for (const j of jobs) j.args = j.args.map(a => a === '@APPIMAGE@' ? appImage() : a);
    ready.appimage = true; })());
  if (needWeb) prep.push((async () => { const t = Date.now(); const c = await sh(process.execPath, ['copy-web.js'], path.join(ROOT, 'android-app')); if (c !== 0) { console.log('demo page: copy-web.js failed'); process.exit(2); } console.log(`demo page: copied in ${secs(t)}`); ready.web = true; })());
  console.log(`${jobs.length} jobs, ${JOBS} at a time${only ? ' (only ' + only.join(', ') + ')' : ''}`);

  // Every job runs headless, never on the screen in use: the desktop tests get xvfb-run's virtual X screen, but on a Wayland
  // session Electron (39 and later) opens its windows on Wayland whenever WAYLAND_DISPLAY is set, so they showed up on the
  // real desktop. The Wayland variables are left out and the session type says X11 (Electron 39 picks its platform from
  // XDG_SESSION_TYPE: left at wayland with no Wayland display, the app couldn't start at all); the browsers the demo and
  // device tests start are headless already.
  const HEADLESS_ENV = { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: 'x11', XDG_SESSION_TYPE: 'x11' };
  for (const k of ['WAYLAND_DISPLAY', 'WAYLAND_SOCKET']) delete HEADLESS_ENV[k];
  // ...and quietly: no core dumps (ulimit -c 0), so an app a test stops never turns into a "crashed" notification from the
  // desktop's crash reporter (the tests themselves stop the app the clean way: SIGTERM to its main process, then SIGKILL)
  const quiet = (cmd, args) => ['sh', ['-c', 'ulimit -c 0 2>/dev/null; exec "$@"', 'job', cmd, ...args]];
  const queue = jobs.slice(); let lastStart = 0;
  const start = j => new Promise(res => {
    const t = Date.now(), log = fs.createWriteStream(path.join(logDir, j.name + '.log'));
    const p = spawn(...quiet(j.cmd, j.args), { cwd: j.cwd, env: { ...HEADLESS_ENV, ...j.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(p); let out = '';
    p.stdout.on('data', d => { out += d; log.write(d); }); p.stderr.on('data', d => log.write(d));
    p.on('error', e => { log.write('could not start: ' + e.message); });
    p.on('close', code => {
      running.delete(p); log.end();
      const lines = out.split('\n'), bad = lines.filter(l => /^(FAIL|❌)|^\| ❌/.test(l)), good = lines.filter(l => /^(PASS|✅)|^\| ✅/.test(l)).length;
      const unknown = bad.filter(l => !KNOWN.some(k => l.includes(k))), known = bad.length - unknown.length;
      const ok = code === 0 || (bad.length === 0 && /all passed/i.test(out)) || (code === 1 && bad.length > 0 && !unknown.length);
      // a headless browser that couldn't start properly while many others were starting (not a failed check): once more, later
      if (!ok && !j.retried && HARNESS.test(out)) { j.retried = true; console.log(`again ${j.name.padEnd(22)} (the browser failed to start: ${(HARNESS.exec(out) || [''])[0]}), once more`); queue.push(j); return res(); }
      const r = { name: j.name + (j.retried ? ' (2nd try)' : ''), kind: j.kind, ok, code, secs: secs(t), passed: good, failed: unknown, known };
      results.push(r); if (!ok || !QUIET) console.log(`${ok ? 'ok  ' : 'FAIL'} ${j.name.padEnd(24)} ${r.secs.padStart(5)}${good ? '  ' + good + ' checks' : ''}${known ? '  (' + known + ' known)' : ''}${ok ? '' : '  exit ' + code}`);
      for (const l of unknown.slice(0, 6)) console.log('       ' + l.slice(0, 220));
      res();
    });
  });
  const active = new Set();
  while (queue.length || active.size) {
    const i = queue.findIndex(j => j.wait.every(w => ready[w]));
    if (i >= 0 && active.size < JOBS) {
      const j = queue.splice(i, 1)[0], gap = Math.max(0, lastStart + 900 - Date.now()); // (xvfb-run -a picks its screen number: not two at the very same moment)
      lastStart = Date.now() + gap; await sleep(gap);
      const pr = start(j).then(() => active.delete(pr)); active.add(pr); continue;
    }
    await Promise.race([sleep(300), ...active]);
  }
  await Promise.all(prep);
  // a page test that failed while everything ran at once (some checks time touches and animations, and slip when seven
  // browsers share the processor): once more on its own, with nothing else running. Passing then, it's said plainly (it's not
  // hidden); failing again, it's a real failure
  const slow = results.filter(r => !r.ok && (r.kind === 'device' || r.kind === 'demo'));
  for (const r of slow) {
    const j = jobs.find(x => x.name === r.name.replace(/ \(2nd try\)$/, '')); if (!j) continue;
    console.log(`alone ${j.name.padEnd(22)} (failed while everything ran at once: on its own now)`);
    j.retried = true; const before = results.length; await start(j); const again = results[before];
    if (again && again.ok) { again.name = j.name + ' (passed on its own: timing under load)'; again.underLoad = r.failed; results.splice(results.indexOf(r), 1); }
  }
  const flaky = results.filter(r => r.underLoad);
  if (flaky.length) { console.log(`\nPassed only on their own (timing-sensitive checks that slipped under load):`); for (const r of flaky) { console.log(`  ${r.name}`); for (const l of r.underLoad.slice(0, 4)) console.log('     ' + l.slice(0, 200)); } }
  const bad = results.filter(r => !r.ok), checks = results.reduce((n, r) => n + r.passed, 0);
  console.log(`\n${bad.length ? bad.length + ' of ' + results.length + ' jobs FAILED: ' + bad.map(r => r.name).join(', ') : 'all ' + results.length + ' jobs passed'} · ${checks} checks · ${secs(t0)}`);
  process.exit(bad.length ? 1 : 0);
})();
