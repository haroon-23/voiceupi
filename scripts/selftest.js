// VoiceUPI selftest: compiles src/lib with the project's own TypeScript and runs
// assertions in plain Node. No test framework, no new runtime dependencies.
// Covers: intent actions, amount safety, VPA/QR validation, storage
// normalization + legacy migration + delete, unknown-status honesty.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
// realpathSync: /tmp is a symlink (macOS /private/tmp). Without canonicalizing,
// Node caches the stub under two keys and storage reads a different instance
// than the test seeds — silent false results.
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voiceupi-selftest-')));

// 1. Compile the pure-logic libs with the repo's TypeScript.
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'tsc'),
  [
    path.join(ROOT, 'src', 'lib', 'intent.ts'),
    path.join(ROOT, 'src', 'lib', 'upi.ts'),
    path.join(ROOT, 'src', 'lib', 'storage.ts'),
    path.join(ROOT, 'src', 'lib', 'types.ts'),
    '--outDir', OUT,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--skipLibCheck',
  ],
  { stdio: 'pipe' },
);

// 2. Stub native-only modules before requiring the build.
const mem = new Map();
fs.writeFileSync(
  path.join(OUT, 'stub-async-storage.js'),
  `const mem = new Map();
const api = {
  getItem: async k => (mem.has(k) ? mem.get(k) : null),
  setItem: async (k, v) => { mem.set(k, String(v)); },
  removeItem: async k => { mem.delete(k); },
};
module.exports = api;
module.exports.default = api;
module.exports.__mem = mem;`,
);
fs.writeFileSync(
  path.join(OUT, 'stub-linking.js'),
  `const api = {
  openURL: async () => true,
  parse: () => ({ queryParams: {} }),
  addEventListener: () => ({ remove: () => {} }),
};
module.exports = api;
module.exports.default = api;`,
);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@react-native-async-storage/async-storage') {
    return path.join(OUT, 'stub-async-storage.js');
  }
  if (request === 'expo-linking') return path.join(OUT, 'stub-linking.js');
  return origResolve.call(this, request, ...rest);
};

const { parseIntent, parseAmountInput, MAX_UPI_AMOUNT } = require(path.join(OUT, 'intent.js'));
const { parseUpiUri, describeUpiQrProblem, isValidVpa, buildUpiPayUrl } = require(path.join(OUT, 'upi.js'));
const { getTransactions, saveTransaction, updateTransaction, deleteTransaction } = require(path.join(
  OUT,
  'storage.js',
));

let passed = 0;
const queue = [];
function check(name, fn) {
  queue.push({ name, fn });
}

async function main() {
  const run = async () => {
    for (const { name, fn } of queue) {
      try {
        await fn();
        passed += 1;
      } catch (e) {
        console.error(`FAIL: ${name}\n  ${e && e.message ? e.message : e}`);
        process.exitCode = 1;
      }
    }
  };
  // --- intent: payment with VPA goes straight to confirm-worthy data ---
  check('vpa intent carries amount + vpa, no missing', () => {
    const i = parseIntent('Pay 250 rupees to rahul@upi');
    assert.strictEqual(i.action, 'SCAN_AND_PAY');
    assert.strictEqual(i.amount, 250);
    assert.strictEqual(i.recipientVpa, 'rahul@upi');
    assert.deepStrictEqual(i.missing, []);
    assert.strictEqual(i.clarification, null);
  });

  check('bare amount without recipient asks for recipient', () => {
    const i = parseIntent('Pay 500');
    assert.strictEqual(i.action, 'SCAN_AND_PAY');
    assert.strictEqual(i.amount, 500);
    assert.deepStrictEqual(i.missing, ['recipient']);
    assert.ok(i.clarification && i.clarification.length > 0);
  });

  check('amount-less payment asks for amount', () => {
    const i = parseIntent('Pay Rahul');
    assert.strictEqual(i.action, 'SCAN_AND_PAY');
    assert.strictEqual(i.amount, null);
    assert.ok(i.missing.includes('amount'));
  });

  check('orphan name is never auto-resolved to a VPA', () => {
    const i = parseIntent('Pay Rahul 500');
    assert.strictEqual(i.recipientVpa, null);
    assert.ok(i.missing.includes('recipient'));
  });

  check('explicit QR request skips recipient interrogation', () => {
    const i = parseIntent('Pay 120 using this QR code');
    assert.strictEqual(i.action, 'SCAN_AND_PAY');
    assert.strictEqual(i.explicitQr, true);
    assert.deepStrictEqual(i.missing, []);
  });

  check('history intent', () => {
    assert.strictEqual(parseIntent('Show my recent transactions').action, 'SHOW_HISTORY');
  });
  check('cancel intent', () => {
    assert.strictEqual(parseIntent('Cancel').action, 'CANCEL');
  });
  check('go-back intent', () => {
    assert.strictEqual(parseIntent('Go back').action, 'GO_BACK');
  });
  check('start-over intent', () => {
    assert.strictEqual(parseIntent('Start over').action, 'START_OVER');
  });
  check('repeat intent', () => {
    assert.strictEqual(parseIntent('Repeat the payment details').action, 'REPEAT');
  });
  check('help intent', () => {
    assert.strictEqual(parseIntent('Help').action, 'HELP');
  });
  check('random speech is UNKNOWN, never payable', () => {
    const i = parseIntent('hello beautiful morning');
    assert.strictEqual(i.action, 'UNKNOWN');
    assert.strictEqual(i.amount, null);
  });
  check('stop is cancel, not record-expense', () => {
    assert.strictEqual(parseIntent('Stop').action, 'CANCEL');
  });

  // --- amount safety ---
  check('amount bounds table', () => {
    assert.strictEqual(parseAmountInput('500'), 500);
    assert.strictEqual(parseAmountInput('1,000'), 1000);
    assert.strictEqual(parseAmountInput(''), null);
    assert.strictEqual(parseAmountInput('0'), null);
    assert.strictEqual(parseAmountInput('-5'), null);
    assert.strictEqual(parseAmountInput('NaN'), null);
    assert.strictEqual(parseAmountInput('Infinity'), null);
    assert.strictEqual(parseAmountInput(String(MAX_UPI_AMOUNT + 1)), null);
    assert.strictEqual(parseIntent('pay 2 coffees 400').amount, null);
  });

  // --- VPA / QR ---
  check('valid UPI QR accepted', () => {
    const q = parseUpiUri('upi://pay?pa=merchant@okhdfc&pn=Store&am=150&cu=INR');
    assert.ok(q && q.pa === 'merchant@okhdfc' && q.am === '150');
  });
  check('missing/invalid VPA rejected with message', () => {
    assert.strictEqual(parseUpiUri('upi://pay?pn=x'), null);
    assert.strictEqual(parseUpiUri('upi://pay?pa=a@b'), null);
    assert.ok(describeUpiQrProblem('upi://pay?pn=x').includes('payee'));
    assert.ok(describeUpiQrProblem('notaupi').includes('not a UPI code'));
  });
  check('non-INR rejected', () => {
    assert.strictEqual(parseUpiUri('upi://pay?pa=a@bank&cu=USD'), null);
  });
  check('bad am dropped, merchant preserved', () => {
    const q = parseUpiUri('upi://pay?pa=shop@upi&am=abc');
    assert.ok(q && q.am === undefined && q.pa === 'shop@upi');
  });
  check('handoff URL encodes fields, never a PIN', () => {
    const url = buildUpiPayUrl({ pa: 's@b', pn: 'S', cu: 'INR', raw: 'x' }, 100, 'lunch');
    assert.ok(url.startsWith('upi://pay?'));
    assert.ok(!/pin/i.test(url));
    assert.ok(url.includes('am=100.00'));
  });
  check('isValidVpa shared helper', () => {
    assert.ok(isValidVpa('name@bank') && !isValidVpa('x@y'));
  });

  // --- storage: normalization, legacy, delete, unknown status ---
  const tx = (over = {}) => ({
    id: `t-${Math.random().toString(36).slice(2)}`,
    kind: 'upi_handoff',
    status: 'initiated',
    amount: 10,
    merchantName: null,
    merchantVpa: 's@b',
    category: null,
    purpose: null,
    rawCommand: 'test',
    createdAt: new Date().toISOString(),
    upiUrl: 'upi://pay?pa=s%40b',
    ...over,
  });

  check('legacy note migrates to manual_note/recorded, never success', async () => {
    const store = require(path.join(OUT, 'stub-async-storage.js')).__mem;
    store.set(
      '@voiceupi/transactions/v1',
      JSON.stringify([{ id: 'old1', status: 'success', amount: 5, createdAt: '2024-01-01' }]),
    );
    const all = await getTransactions();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].kind, 'manual_note');
    assert.strictEqual(all[0].status, 'recorded');
  });

  check('legacy handoff success demotes to pending (unverified)', async () => {
    const store = require(path.join(OUT, 'stub-async-storage.js')).__mem;
    store.set(
      '@voiceupi/transactions/v1',
      JSON.stringify([{ id: 'old2', status: 'success', upiUrl: 'upi://x', merchantVpa: 'a@b', createdAt: '2024-01-01' }]),
    );
    const all = await getTransactions();
    assert.strictEqual(all[0].kind, 'upi_handoff');
    assert.strictEqual(all[0].status, 'pending');
  });

  check('malformed records dropped without crash', async () => {
    const store = require(path.join(OUT, 'stub-async-storage.js')).__mem;
    store.set('@voiceupi/transactions/v1', JSON.stringify([null, 42, { no: 'id' }, tx({ id: 'good' })]));
    const all = await getTransactions();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].id, 'good');
  });

  check('corrupt JSON returns empty, no throw', async () => {
    const store = require(path.join(OUT, 'stub-async-storage.js')).__mem;
    store.set('@voiceupi/transactions/v1', '{{{not json');
    assert.deepStrictEqual(await getTransactions(), []);
  });

  check('newest-first ordering + delete', async () => {
    const store = require(path.join(OUT, 'stub-async-storage.js')).__mem;
    store.delete('@voiceupi/transactions/v1');
    await saveTransaction(tx({ id: 'a' }));
    await saveTransaction(tx({ id: 'b' }));
    let all = await getTransactions();
    assert.deepStrictEqual(all.map(t => t.id), ['b', 'a']);
    await updateTransaction('a', { status: 'failed' });
    all = await getTransactions();
    assert.strictEqual(all.find(t => t.id === 'a').status, 'failed');
    await deleteTransaction('b');
    all = await getTransactions();
    assert.deepStrictEqual(all.map(t => t.id), ['a']);
  });

  check('opening a handoff never implies success (unknown resting state)', async () => {
    const store = require(path.join(OUT, 'stub-async-storage.js')).__mem;
    store.delete('@voiceupi/transactions/v1');
    await saveTransaction(tx({ id: 'h', status: 'initiated' }));
    const all = await getTransactions();
    assert.ok(['initiated', 'pending'].includes(all[0].status));
    assert.notStrictEqual(all[0].status, 'success');
  });

  await run();
  console.log(`selftest: ${passed} assertions passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
  fs.rmSync(OUT, { recursive: true, force: true });
}

main().catch(e => {
  console.error(`FATAL: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
