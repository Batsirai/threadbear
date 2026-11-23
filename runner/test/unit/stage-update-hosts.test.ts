// Where the GPUI app's update is built (desktop/scripts/stage-update.sh).
// What the build host sends back is what the main Mac runs next, so a check
// host, trusted only to run tests, must never become one by being in
// checkHosts: only updateBuildHosts names a builder (Daybreak 108, 12 Nov
// 2026). A Mac with check hosts keeps heavy builds off itself, so with no
// update build host it builds nothing at all rather than building here.
//
// The script runs for real against a tiny checkout whose remote.sh,
// make-bundle.sh and cargo are stand-ins that only note they ran. Hosts are
// .invalid names, so ssh's look at them fails at once and nothing leaves
// this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';

const SCRIPT = path.join(import.meta.dirname, '..', '..', '..', 'desktop', 'scripts', 'stage-update.sh');

function write(file: string, text: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

// rust: 'rustup' has a stand-in rustup beside cargo, whose `run stable`
// runs that cargo; 'none' is a Mac with only a cargo (Homebrew's rust).
// cargoFails: the build fails.
// A toolchain's parts as Rust's manifest lists them, and the pins main
// keeps for them (desktop/scripts/rust-toolchain.pins); `tampered` changes
// one hash in what rustup installed.
const PARTS = ['rustc', 'cargo', 'rust-std'];
const HOSTS = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const hashOf = (part: string, xz = false) => (xz ? 'e' : 'd').repeat(4) + Buffer.from(part).toString('hex').padEnd(60, '0');
const PINS = `# version target part hash xz_hash\n${HOSTS.flatMap((h) => PARTS.map((p) => `1.99.1 ${h} ${p} ${hashOf(p)} ${hashOf(p, true)}`)).join('\n')}\n`;
function manifest(host: string, tampered = false) {
  return `manifest-version = "2"\n\n${PARTS.map((p) => `[pkg.${p}.target.${host}]\navailable = true\nhash = "${tampered && p === 'rustc' ? 'f'.repeat(64) : hashOf(p)}"\nxz_hash = "${hashOf(p, true)}"\n`).join('\n')}\n[pkg.rustc.target.other-target]\nhash = "${'0'.repeat(64)}"\n`;
}

function setup(config: Record<string, unknown> | null, remote?: 'busy' | 'legacy' | 'slow', rust: 'rustup' | 'none' | 'offline' | 'tampered' = 'rustup', cargoFails = false, toolchain: string | null = '[toolchain]\nchannel = "1.99.1"\ncomponents = ["rustfmt", "clippy"]\n', pins: string | null = PINS) {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const marks = path.join(root, 'marks');
  fs.mkdirSync(marks, { recursive: true });
  const checkout = path.join(root, 'checkout');
  const note = (what: string) => `#!/bin/bash\necho "$*" >> '${marks}/${what}'\n`;
  write(path.join(checkout, 'desktop', 'scripts', 'remote.sh'), `${note('remote')}
cat >/dev/null
echo "try=\${THREADBEAR_REMOTE_TRY-unset}" >> '${marks}/remote'
[ "$1" != gone.invalid ] || exit 3
${remote === 'busy' ? '[ "$1" = free.invalid ] || [ "${THREADBEAR_REMOTE_TRY-}" != 1 ] || exit 75' : ''}
${remote === 'slow' ? `echo $$ > '${marks}/remote-pid'; trap 'echo stopped >> "${marks}/remote"; exit 143' TERM; sleep 30 & wait` : ''}
${remote === 'legacy' ? '[ "$2" = -- ] || exit 127' : ''}
echo BUILT_IN=/mock-target
`, 0o755);
  write(path.join(checkout, 'desktop', 'scripts', 'make-bundle.sh'), `${note('bundle')}echo "builtOn=\${THREADBEAR_BUILT_ON-unset}" >> '${marks}/bundle'\nmkdir -p "$2"\n`, 0o755);
  // cargo, for a build here: it notes it ran and leaves the two binaries.
  write(path.join(home, '.cargo', 'bin', 'cargo'), `${note('cargo')}[ "$1" = build ] || exit 0\n${cargoFails ? 'exit 101\n' : ''}mkdir -p "$CARGO_TARGET_DIR/release"\ntouch "$CARGO_TARGET_DIR/release/threadbear-gpui" "$CARGO_TARGET_DIR/release/threadbear-web-helper"\n`, 0o755);
  if (rust === 'rustup') write(path.join(home, '.cargo', 'bin', 'rustup'), `${note('rustup')}[ "$1" = run ] || exit 0\nshift 2\nexec "$@"\n`, 0o755);
  // A rustup that can't reach Rust's servers and hasn't the pinned version.
  if (rust === 'offline') write(path.join(home, '.cargo', 'bin', 'rustup'), `${note('rustup')}exit 1\n`, 0o755);
  if (rust === 'tampered') write(path.join(home, '.cargo', 'bin', 'rustup'), `${note('rustup')}[ "$1" = run ] || exit 0\nshift 2\nexec "$@"\n`, 0o755);
  // What rustup installed: the toolchain with the manifest it checked its parts against.
  if (rust === 'rustup' || rust === 'tampered') {
    for (const host of HOSTS) write(path.join(home, '.rustup', 'toolchains', `1.99.1-${host}`, 'lib', 'rustlib', 'multirust-channel-manifest.toml'), manifest(host, rust === 'tampered'));
  }
  if (toolchain !== null) write(path.join(checkout, 'rust-toolchain.toml'), toolchain);
  if (pins !== null) write(path.join(checkout, 'desktop', 'scripts', 'rust-toolchain.pins'), pins);
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  if (config) fs.writeFileSync(path.join(data, 'runner.json'), JSON.stringify(config));
  const args = [SCRIPT, checkout, '--next', path.join(root, 'next.app')];
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, ...extra, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, THREADBEAR_HOME: data,
    ...(remote ? { 'BASH_FUNC_ssh%%': '() { cat >/dev/null; echo Darwin; }', 'BASH_FUNC_ioreg%%': '() { :; }', 'BASH_FUNC_scp%%': '() { touch "${@: -1}"; }' } : {}),
  });
  const run = Object.assign((extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', args, {
      encoding: 'utf8',
      timeout: 60_000,
      // Only the system's tools beside the stand-ins: a real rustup on the
      // test machine's PATH would really install Rust.
      // Only the system's tools beside the stand-ins; bash imports the ssh
      // stand-in even though stage-update sets a system PATH.
      env: env(extra),
    });
    const marked = (what: string) => (fs.existsSync(path.join(marks, what)) ? fs.readFileSync(path.join(marks, what), 'utf8') : '');
    const deferred = path.join(home, 'Library', 'Caches', 'Threadbear', 'update-desktop', 'deferred-since');
    return { status: r.status, out: `${r.stdout}${r.stderr}`, marked, root, deferred };
  }, { start: () => ({ child: spawn('bash', args, { env: env(), stdio: 'ignore' }), marks }) });
  return run;
}

test('check hosts alone never build the update, and this Mac does not build it either', () => {
  const r = setup({ checkHost: 'checker.invalid', checkHosts: ['checker.invalid', 'cloud.invalid'] })();
  assert.equal(r.status, 5, r.out);
  assert.equal(r.marked('remote'), '', 'nothing sent to a check host to build');
  assert.equal(r.marked('cargo'), '', 'nothing built here');
  assert.equal(r.marked('bundle'), '', 'nothing staged');
  assert.match(r.out, /updateBuildHosts/);
  assert.ok(!fs.existsSync(path.join(r.root, 'next.app')));
});

test('a busy update host defers without staging or marking main as broken', () => {
  const r = setup({ updateBuildHosts: ['builder.invalid'] }, 'busy')();
  assert.equal(r.status, 4, r.out);
  assert.match(r.marked('remote'), /try=1/);
  assert.equal(r.marked('bundle'), '');
  assert.equal(r.marked('cargo'), '');
  assert.match(r.out, /busy|queued/i);
});

// Agents kept Tinker Desk busy all day on 18 Nov, and 63 tries built
// nothing while fixes sat on main. Busy for long enough, it queues.
test('busy hosts for long enough: the update queues for the lease instead of trying again', () => {
  const run = setup({ updateBuildHosts: ['builder.invalid'] }, 'busy');
  const first = run();
  assert.equal(first.status, 4, first.out);
  const since = fs.readFileSync(first.deferred, 'utf8').trim();
  assert.match(since, /^\d+$/);
  // Still inside the grace: tries again later, and keeps when it started.
  const second = run();
  assert.equal(second.status, 4, second.out);
  assert.equal(fs.readFileSync(second.deferred, 'utf8').trim(), since);
  assert.doesNotMatch(second.marked('remote'), /try=0/);
  // Past it: one try, then queued on the busy host, built and staged.
  const third = run({ THREADBEAR_UPDATE_QUEUE_AFTER: '0' });
  assert.equal(third.status, 0, third.out);
  assert.match(third.out, /waits its turn on builder\.invalid/);
  assert.match(third.marked('remote'), /try=1\n[^]*builder\.invalid --[^]*try=0\n$/);
  assert.match(third.marked('bundle'), /^builtOn=builder\.invalid$/m);
  assert.ok(!fs.existsSync(third.deferred), 'a build clears the deferral');
});

test('a host that went away after a busy one neither resets the busy clock nor stops the queueing', () => {
  const run = setup({ updateBuildHosts: ['busy.invalid', 'gone.invalid'] }, 'busy');
  const first = run();
  assert.equal(first.status, 4, first.out);
  const since = fs.readFileSync(first.deferred, 'utf8').trim();
  const later = run({ THREADBEAR_UPDATE_QUEUE_AFTER: '0' });
  assert.equal(later.status, 0, later.out);
  assert.match(later.out, /waits its turn on busy\.invalid/);
  assert.match(later.marked('bundle'), /^builtOn=busy\.invalid$/m);
  assert.ok(since && !fs.existsSync(later.deferred));
});

test("the app's SIGTERM at quit stops remote.sh too, not just the script", async () => {
  const { child, marks } = setup({ updateBuildHosts: ['builder.invalid'] }, 'slow').start();
  const pidFile = path.join(marks, 'remote-pid');
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  assert.equal(code, 143);
  assert.match(fs.readFileSync(path.join(marks, 'remote'), 'utf8'), /stopped/);
  assert.throws(() => process.kill(pid, 0), 'remote.sh is gone when the script has exited');
});

test('a busy trusted host leaves the next trusted host a chance to build', () => {
  const r = setup({ updateBuildHosts: ['busy.invalid', 'free.invalid'], checkHosts: ['checker.invalid'] }, 'busy')();
  assert.equal(r.status, 0, r.out);
  assert.match(r.marked('remote'), /busy\.invalid --[^]*free\.invalid --/);
  assert.match(r.marked('bundle'), /^builtOn=free\.invalid$/m);
  assert.doesNotMatch(r.marked('remote'), /checker\.invalid/);
});

test('an installed updater can build main rolled back to a remote.sh from before --try', () => {
  const r = setup({ updateBuildHosts: ['legacy.invalid'] }, 'legacy')();
  assert.equal(r.status, 0, r.out);
  assert.match(r.marked('remote'), /^legacy\.invalid -- bash/m);
  assert.match(r.marked('bundle'), /^builtOn=legacy\.invalid$/m);
});

test('the single checkHost of a runner.json from before the list keeps this Mac from building too', () => {
  const r = setup({ checkHost: 'checker.invalid' })();
  assert.equal(r.status, 5, r.out);
  assert.equal(r.marked('cargo'), '');
  assert.equal(r.marked('remote'), '');
});

test('only the update build hosts are tried, never the check hosts beside them', () => {
  const r = setup({ checkHosts: ['checker.invalid'], updateBuildHosts: ['builder.invalid'] })();
  // builder.invalid doesn't answer: wait and try again later, no build here.
  assert.equal(r.status, 4, r.out);
  assert.match(r.out, /update build hosts \(builder\.invalid \)/);
  assert.doesNotMatch(r.out, /checker\.invalid/);
  assert.equal(r.marked('cargo'), '');
  assert.equal(r.marked('remote'), '');
});

test("a host name ssh would take as an option is never a builder", () => {
  const r = setup({ checkHosts: ['checker.invalid'], updateBuildHosts: ['-oProxyCommand=touch /tmp/tb-stage-pwned', ' spaced.invalid', 7] })();
  assert.equal(r.status, 5, r.out);
  assert.equal(r.marked('cargo'), '');
  assert.equal(r.marked('remote'), '');
});

test("someone else's copy with neither builds here, and the bundle says so", () => {
  for (const config of [null, {}, { updateBuildHosts: [] }]) {
    const r = setup(config)();
    assert.equal(r.status, 0, r.out);
    assert.notEqual(r.marked('cargo'), '', 'built here');
    assert.equal(r.marked('remote'), '');
    assert.match(r.marked('bundle'), /^builtOn=$/m, 'built on this Mac, said as ""');
  }
});

// Daybreak 173: the compiler writes the app this Mac runs next, so it's the
// exact one main's rust-toolchain.toml pins, never whatever rustup's stable
// is today.
test("a build here uses exactly the Rust main's rust-toolchain.toml pins, through rustup, never stable", () => {
  const r = setup(null)();
  assert.equal(r.status, 0, r.out);
  assert.match(r.marked('rustup'), /^toolchain install 1\.99\.1 --profile minimal --no-self-update$/m);
  assert.match(r.marked('rustup'), /^run 1\.99\.1 cargo build --release -p threadbear-gpui /m);
  assert.doesNotMatch(r.marked('rustup'), /stable/);
  assert.match(r.marked('cargo'), /^build --release/m);
});

test('a toolchain file that pins no exact version builds nothing', () => {
  for (const toolchain of [null, '[toolchain]\nchannel = "stable"\n', '[toolchain]\nchannel = "nightly-2026-11-01"\n', '[toolchain]\nchannel = "1.99"\n', '[toolchain]\nchannel = "1.99.1; rm -rf ~"\n']) {
    const r = setup(null, undefined, 'rustup', false, toolchain)();
    assert.equal(r.status, 1, `${toolchain}: ${r.out}`);
    assert.match(r.out, /doesn't pin an exact Rust/);
    assert.equal(r.marked('cargo'), '', 'nothing built');
    assert.equal(r.marked('rustup'), '', 'nothing fetched');
    assert.equal(r.marked('bundle'), '');
  }
});

test("a rustup that can't get the pinned Rust builds nothing rather than with its default", () => {
  const r = setup(null, undefined, 'offline')();
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Couldn't get Rust 1\.99\.1/);
  assert.equal(r.marked('cargo'), '');
  assert.equal(r.marked('bundle'), '');
});

test('a toolchain whose parts are not the ones main pins builds nothing, and none of it runs', () => {
  const tampered = setup(null, undefined, 'tampered')();
  assert.equal(tampered.status, 1, tampered.out);
  assert.match(tampered.out, /isn't the one main pins/);
  assert.equal(tampered.marked('cargo'), '', 'its cargo never ran');
  assert.doesNotMatch(tampered.marked('rustup'), /^run /m, 'nothing run through rustup');
  assert.equal(tampered.marked('bundle'), '');
  // Pins that leave a part out, or name another version, pass nothing either.
  for (const pins of [null, PINS.split('\n').filter((l) => !/ cargo /.test(l)).join('\n'), PINS.replaceAll('1.99.1', '1.98.0')]) {
    const r = setup(null, undefined, 'rustup', false, undefined, pins)();
    assert.equal(r.status, 1, `${pins}: ${r.out}`);
    assert.equal(r.marked('cargo'), '');
  }
});

test("the repo's toolchain pins are for rust-toolchain.toml's version, every part, both kinds of Mac", () => {
  const root = path.join(import.meta.dirname, '..', '..', '..');
  const channel = /^channel = "([^"]+)"$/m.exec(fs.readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8'))![1];
  const lines = fs.readFileSync(path.join(root, 'desktop', 'scripts', 'rust-toolchain.pins'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const seen = lines.map((l) => {
    const [version, host, part, hash, xz, extra] = l.split(' ');
    assert.equal(version, channel, 'move the pins with rust-toolchain.toml');
    assert.match(hash!, /^[0-9a-f]{64}$/);
    assert.match(xz!, /^[0-9a-f]{64}$/);
    assert.equal(extra, undefined);
    return `${host} ${part}`;
  });
  assert.deepEqual(seen.sort(), HOSTS.flatMap((h) => PARTS.map((p) => `${h} ${p}`)).sort());
});

test('no production build script asks rustup for a floating channel', () => {
  const scripts = path.join(import.meta.dirname, '..', '..', '..', 'desktop', 'scripts');
  for (const name of ['stage-update.sh', 'switch-from-swift.sh', 'remote.sh', 'make-bundle.sh']) {
    const text = fs.readFileSync(path.join(scripts, name), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(text, /rustup[^\n]*\b(stable|beta|nightly)\b/, name);
    assert.doesNotMatch(text, /--default-toolchain\s+(stable|beta|nightly)/, name);
    assert.doesNotMatch(text, /sh\.rustup\.rs/, name);
  }
});

test("with only a cargo (Homebrew's rust) it builds with that, and a failed build says which Rust it's tested on", () => {
  const ok = setup(null, undefined, 'none')();
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.marked('cargo'), /^build --release/m);
  const failed = setup(null, undefined, 'none', true)();
  assert.equal(failed.status, 101, failed.out);
  assert.match(failed.out, /tested on Rust 1\.99\.1 \(rust-toolchain\.toml\): rustup \(https:\/\/rustup\.rs\)/);
  const viaRustup = setup(null, undefined, 'rustup', true)();
  assert.equal(viaRustup.status, 101);
  assert.doesNotMatch(viaRustup.out, /rustup\.rs/, 'already on the Rust it tests with');
});

// An installed app's older stage-update.sh runs from its own bundle but takes
// make-bundle.sh from main, and it built on a check host. It says nothing
// about where it built, so main's make-bundle.sh takes its binaries only if
// they're the build it made on this Mac, which it keeps beside them.
const MAKE_BUNDLE = path.join(import.meta.dirname, '..', '..', '..', 'desktop', 'scripts', 'make-bundle.sh');

test("an older updater's binaries from a check host are never made into a bundle", () => {
  const cache = tmpDir();
  const bins = path.join(cache, 'bins');
  for (const bin of ['threadbear-gpui', 'threadbear-web-helper']) write(path.join(bins, bin), 'from the check host', 0o755);
  const make = (env: Record<string, string | undefined>) => {
    const e: Record<string, string | undefined> = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
    return spawnSync('bash', [MAKE_BUNDLE, bins, path.join(cache, 'next.app')], { encoding: 'utf8', env: e as NodeJS.ProcessEnv });
  };
  // Nothing built here beside them: refused, and no bundle.
  let r = make({ THREADBEAR_BUILT_ON: undefined });
  assert.equal(r.status, 6, r.stderr);
  assert.ok(!fs.existsSync(path.join(cache, 'next.app')));
  // A different build here: still refused.
  for (const bin of ['threadbear-gpui', 'threadbear-web-helper']) write(path.join(cache, 'target', 'release', bin), 'built here', 0o755);
  r = make({ THREADBEAR_BUILT_ON: undefined });
  assert.equal(r.status, 6, r.stderr);
  // The same bytes as the build here (an older updater building on this Mac,
  // as anyone else's copy does) get past this check, as does a caller that
  // says where it built.
  for (const bin of ['threadbear-gpui', 'threadbear-web-helper']) write(path.join(bins, bin), 'built here', 0o755);
  r = make({ THREADBEAR_BUILT_ON: undefined });
  assert.notEqual(r.status, 6, r.stderr);
  for (const bin of ['threadbear-gpui', 'threadbear-web-helper']) write(path.join(bins, bin), 'from somewhere named', 0o755);
  r = make({ THREADBEAR_BUILT_ON: 'builder' });
  assert.notEqual(r.status, 6, r.stderr);
});
