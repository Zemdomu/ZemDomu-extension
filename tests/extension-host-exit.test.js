const assert = require('assert');
const { exitAfterOutput } = require('./extension-host/exit-after-output');

function fakeStream(overrides = {}) {
  const callbacks = [];
  return {
    callbacks,
    destroyed: false,
    writable: true,
    write(value, callback) {
      assert.strictEqual(value, '');
      callbacks.push(callback);
    },
    ...overrides,
  };
}

function harness() {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const exits = [];
  const cancelled = [];
  let fallback;
  const timer = { id: 'fallback' };

  return {
    stdout,
    stderr,
    exits,
    cancelled,
    options: {
      stdout,
      stderr,
      exit: code => exits.push(code),
      setTimeout(callback, delay) {
        assert.strictEqual(delay, 1000);
        fallback = callback;
        return timer;
      },
      clearTimeout: value => cancelled.push(value),
    },
    runFallback: () => fallback(),
    timer,
  };
}

{
  const test = harness();
  exitAfterOutput(0, test.options);

  assert.strictEqual(test.exits.length, 0, 'exit must wait for pending output');
  test.stdout.callbacks[0]();
  assert.strictEqual(test.exits.length, 0, 'exit must wait for both streams');
  test.stderr.callbacks[0]();
  assert.deepStrictEqual(test.exits, [0]);
  assert.deepStrictEqual(test.cancelled, [test.timer]);

  test.runFallback();
  assert.deepStrictEqual(test.exits, [0], 'the fallback must not exit twice');
}

{
  const test = harness();
  exitAfterOutput(1, test.options);
  test.runFallback();

  assert.deepStrictEqual(test.exits, [1]);
  assert.deepStrictEqual(test.cancelled, [test.timer]);
}

{
  const test = harness();
  test.options.stdout = fakeStream({ writable: false });
  test.options.stderr = fakeStream({ destroyed: true });
  exitAfterOutput(0, test.options);

  assert.deepStrictEqual(test.exits, [0]);
}

console.log('Extension Host exit handling tests passed');
