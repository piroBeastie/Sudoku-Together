/**
 * Unit tests for the sign-in failure limiter.
 *
 * Kept off the HTTP layer on purpose: exercising it through real requests
 * would lock this machine out of the running server for the rest of the run.
 * Time is injected, so the window can be tested without waiting for it.
 *
 *   node test/rate-limit.js
 */

import { createFailureLimiter } from '../server/rate-limit.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

function main() {
  let clock = 0;
  const limiter = createFailureLimiter({ max: 3, windowMs: 1000, now: () => clock });

  console.log('--- counting failures ---');
  check('a fresh key is not blocked', !limiter.isBlocked('a'));
  limiter.recordFailure('a');
  limiter.recordFailure('a');
  check('still allowed below the limit', !limiter.isBlocked('a'));
  limiter.recordFailure('a');
  check('blocked once the limit is reached', limiter.isBlocked('a'));

  console.log('\n--- keys are independent ---');
  check('another key is unaffected', !limiter.isBlocked('b'), 'b never failed');
  limiter.recordFailure('b');
  check('one failure does not block b', !limiter.isBlocked('b'));
  check('a is still blocked', limiter.isBlocked('a'));

  console.log('\n--- success clears the slate ---');
  limiter.clear('a');
  check('cleared key is allowed again', !limiter.isBlocked('a'));
  limiter.recordFailure('a');
  limiter.recordFailure('a');
  limiter.clear('a');
  limiter.recordFailure('a');
  check('the count restarted after clearing', !limiter.isBlocked('a'), '1 failure since clear');

  console.log('\n--- the window expires ---');
  const w = createFailureLimiter({ max: 2, windowMs: 1000, now: () => clock });
  clock = 0;
  w.recordFailure('c');
  w.recordFailure('c');
  check('blocked inside the window', w.isBlocked('c'));
  clock = 999;
  check('still blocked just before it lapses', w.isBlocked('c'));
  clock = 1000;
  check('allowed again once the window lapses', !w.isBlocked('c'));
  w.recordFailure('c');
  check('a lapsed key starts a fresh count', !w.isBlocked('c'), '1 failure in the new window');

  console.log('\n--- ordinary use never trips it ---');
  const normal = createFailureLimiter({ max: 5, windowMs: 60_000, now: () => clock });
  for (let i = 0; i < 50; i++) {
    // Someone signing in and out all day: every attempt succeeds.
    normal.clear('user');
  }
  check('50 successful sign-ins do not block', !normal.isBlocked('user'));

  // A typo followed by a correct password must not accumulate.
  for (let i = 0; i < 20; i++) {
    normal.recordFailure('user');
    normal.clear('user');
  }
  check('mistype-then-success never accumulates', !normal.isBlocked('user'));

  console.log('\n--- pruning keeps the map bounded ---');
  const p = createFailureLimiter({ max: 2, windowMs: 1000, now: () => clock });
  clock = 0;
  for (let i = 0; i < 100; i++) p.recordFailure('key' + i);
  check('100 keys held', p.size() === 100, `size=${p.size()}`);
  check('pruning keeps live keys', p.prune() === 100);
  clock = 5000;
  check('pruning drops expired keys', p.prune() === 0, `size=${p.size()}`);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'All checks passed.'}`);
  process.exit(failures ? 1 : 0);
}

main();
