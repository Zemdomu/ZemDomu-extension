function exitAfterOutput(code, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? process.exit;
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const timeoutMs = options.timeoutMs ?? 1000;

  let exited = false;
  let fallback;
  const finish = () => {
    if (exited) return;
    exited = true;
    if (fallback !== undefined) cancel(fallback);
    exit(code);
  };

  fallback = schedule(finish, timeoutMs);

  const streams = [stdout, stderr].filter(
    stream => stream && stream.writable && !stream.destroyed
  );
  if (streams.length === 0) {
    finish();
    return;
  }

  let pending = streams.length;
  const flushed = () => {
    pending -= 1;
    if (pending === 0) finish();
  };
  for (const stream of streams) stream.write('', flushed);
}

module.exports = { exitAfterOutput };
