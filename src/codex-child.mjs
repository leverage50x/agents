// Only handles returned by this application's spawn calls belong here. An exit
// code does not prove that inherited stdio (and a native child) has closed.
const reaped = new WeakSet();

export function watchCodexChild(child) {
  child.once('close', () => reaped.add(child));
  return child;
}

export function closeCodexChild(child) {
  if (!child || reaped.has(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    const finish = confirmed => {
      if (done) return;
      done = true; clearTimeout(kill); clearTimeout(deadline);
      child.removeListener('close', closed);
      resolve(confirmed);
    };
    const closed = () => finish(true);
    const kill = setTimeout(() => {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
      catch { finish(false); }
    }, 300);
    const deadline = setTimeout(() => finish(false), 1500);
    child.once('close', closed);
    try {
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    } catch { finish(false); }
  });
}
