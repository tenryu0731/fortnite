/**
 * run-all.cjs — full verification sweep. Order matters: harness self-test first,
 * then unit-level checks, then visual regression, touch, and performance.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SUITES = [
  { name: 'selftest', file: 'selftest.cjs', always: true },
  { name: 'unit', file: 'unit.cjs' },
  { name: 'gameplay', file: 'gameplay.cjs' },
  { name: 'touch', file: 'touch.cjs' },
  { name: 'visual', file: 'screenshots.cjs' },
  { name: 'perf', file: 'perf.cjs' },
];

function run(file, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit' });
    p.on('close', (code) => resolve(code === 0));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const passthrough = args.filter((a) => a.startsWith('--'));
  const only = args.filter((a) => !a.startsWith('--'));
  const results = [];
  for (const s of SUITES) {
    if (only.length && !only.includes(s.name)) continue;
    const file = path.join(__dirname, s.file);
    if (!fs.existsSync(file)) {
      if (s.always) { console.log(`\n[skip] ${s.name} (missing ${s.file})`); }
      else console.log(`\n[skip] ${s.name} (not implemented yet)`);
      continue;
    }
    const ok = await run(s.file, s.name === 'visual' ? passthrough : passthrough.filter((a) => a !== '--update'));
    results.push({ name: s.name, ok });
  }
  console.log('\n\x1b[1m=== SUMMARY ===\x1b[0m');
  let allOk = true;
  for (const r of results) {
    console.log(`  ${r.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${r.name}`);
    allOk = allOk && r.ok;
  }
  console.log(allOk ? '\n\x1b[32mAll suites passed.\x1b[0m\n' : '\n\x1b[31mSome suites failed.\x1b[0m\n');
  process.exit(allOk ? 0 : 1);
}

main();
