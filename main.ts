// The entry's life in a trial: start the forge on a port the kernel picks, tell the suite which
// port that is, keep serving until the suite says it is finished, then exit 0.
//
//   1. listen(0) and read the bound port (never 8080: the suite's own);
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register (200 accepted, 409 already registered);
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true};
//   4. close the server and exit 0.
//
// For work on the forge itself, FORGE_PORT=<port> serves on that port with no suite to talk to:
//   FORGE_PORT=8787 node --experimental-strip-types main.ts

import { createApp } from './app.ts';
import './src/graphql/index.ts';
import './src/mcp.ts';

const suite = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const fixedPort = Number(process.env.FORGE_PORT ?? '');

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry pauses: 200 ms doubling to 2 s. */
function pause(attempt: number): number {
  return Math.min(2000, 200 * 2 ** Math.min(attempt, 6));
}

/** Tells the suite the forge's port, retrying while the suite is still coming up. */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${suite}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(20_000),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) throw new Error(`the suite refused the registration with HTTP ${answer.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('the suite refused')) throw err;
    }
    await wait(pause(attempt));
  }
}

/** Polls until the suite reports the trial over; a failed poll just polls again. */
async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${suite}/done`, { signal: AbortSignal.timeout(20_000) });
      if (answer.ok && ((await answer.json()) as { done?: unknown }).done === true) return;
    } catch {
      // Not reachable or too slow this time.
    }
    await wait(pause(Math.min(attempt, 1)));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const dev = suite === '' && Number.isInteger(fixedPort) && fixedPort > 0;
  if (suite === '' && !dev) throw new Error('MAKEFUN_ENV_URL is not set, so there is no suite to register with');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(dev ? fixedPort : 0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server holds no TCP port');
  process.stdout.write(`[forge] serving on port ${address.port}\n`);
  if (dev) {
    await new Promise<void>(() => {});
    return;
  }
  await announce(address.port);
  process.stdout.write('[forge] registered with the suite\n');
  await untilDone();
  server.close();
  process.stdout.write('[forge] the suite is done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
