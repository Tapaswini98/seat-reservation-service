/* eslint-disable no-console */
/**
 * On-sale stampede generator.
 *
 * Deliberately uses a bounded worker pool over a keep-alive connection pool
 * rather than firing N unbounded promises. Twenty thousand naked `fetch` calls
 * measure the laptop's file descriptor limit, not the service -- you get a
 * wall of ECONNRESET and learn nothing. Here, `--concurrency` is a real
 * in-flight ceiling and `--requests` is the total, so the numbers describe the
 * server.
 */
import { Agent, request } from 'undici';
import { randomUUID } from 'node:crypto';

interface Options {
  baseUrl: string;
  requests: number;
  concurrency: number;
  scenario: 'mixed' | 'hot-seat' | 'stampede' | 'user-limit' | 'idempotent';
  seats: number;
  hotSeats: number;
  perUserLimit: number;
  adminToken: string;
  holdSeconds?: number;
}

interface Outcome {
  status: number;
  code?: string;
  replay: boolean;
  seat: string;
  user: string;
  reservationId?: string;
  idempotencyKey?: string;
  durationMs: number;
}

const parseArgs = (argv: string[]): Options => {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flag = (name: string, fallback?: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };

  const baseUrl = (
    positional[0] ??
    process.env.BASE_URL ??
    'http://localhost:3000'
  ).replace(/\/+$/, '');

  return {
    baseUrl,
    requests: Number(flag('requests', process.env.REQUESTS ?? '20000')),
    concurrency: Number(flag('concurrency', process.env.CONCURRENCY ?? '200')),
    scenario: flag('scenario', 'mixed') as Options['scenario'],
    seats: Number(flag('seats', '500')),
    hotSeats: Number(flag('hot-seats', '10')),
    perUserLimit: Number(flag('per-user-limit', '4')),
    adminToken: flag('admin-token', process.env.ADMIN_TOKEN ?? 'dev-admin-token')!,
    holdSeconds: flag('hold-seconds') ? Number(flag('hold-seconds')) : undefined,
  };
};

const opts = parseArgs(process.argv.slice(2));

const agent = new Agent({
  connections: Math.min(opts.concurrency, 512),
  pipelining: 1,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
  connectTimeout: 15_000,
  headersTimeout: 60_000,
  bodyTimeout: 60_000,
});

const json = async <T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> => {
  const res = await request(`${opts.baseUrl}${path}`, {
    method,
    dispatcher: agent,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.body.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  return { status: res.statusCode, body: parsed as T };
};

// --- plan ------------------------------------------------------------------

interface PlannedRequest {
  seat: string;
  token: string;
  user: string;
  idempotencyKey?: string;
  holdSeconds?: number;
}

const buildPlan = (
  seatLabels: string[],
  users: Array<{ user: string; token: string }>,
): PlannedRequest[] => {
  const plan: PlannedRequest[] = [];
  const pick = <T>(arr: T[], i: number): T => arr[Math.abs(i) % arr.length];

  // The hall is carved into zones so that the mixed scenario provably produces
  // every outcome class. Sharing one pool of seats between the cohorts looks
  // more realistic but means the seat-taken decline (which is checked first)
  // masks the per-user-limit and idempotent-replay paths, and you end up
  // reporting zeroes for the two behaviours you most wanted to demonstrate.
  const hot = seatLabels.slice(0, opts.hotSeats);
  const rest = seatLabels.slice(opts.hotSeats);
  const third = Math.max(1, Math.floor(rest.length / 3));
  const openZone = rest.slice(0, third);
  const limitZone = rest.slice(third, third * 2);
  const idemZone = rest.slice(third * 2);

  // Small enough that each of them can reach the per-user limit and keep going.
  const limitCohort = users.slice(0, Math.min(25, users.length));

  for (let i = 0; i < opts.requests; i += 1) {
    const u = pick(users, i);

    switch (opts.scenario) {
      case 'hot-seat':
        // Everybody fights over one seat. Exactly one may win.
        plan.push({ seat: hot[0], ...u, holdSeconds: opts.holdSeconds });
        break;

      case 'stampede':
        plan.push({ seat: pick(hot, i), ...u, holdSeconds: opts.holdSeconds });
        break;

      case 'user-limit':
        plan.push({
          seat: pick(rest.length > 0 ? rest : seatLabels, i),
          ...pick(limitCohort, i),
          holdSeconds: opts.holdSeconds,
        });
        break;

      case 'idempotent': {
        // Each key is used four times, so three in four are retries.
        const keyIndex = Math.floor(i / 4);
        plan.push({
          seat: pick(seatLabels, keyIndex),
          ...pick(users, keyIndex),
          idempotencyKey: `burst-key-${keyIndex}`,
          holdSeconds: opts.holdSeconds,
        });
        break;
      }

      default: {
        // mixed: a hot-seat storm with cold-seat buyers, an over-limit cohort
        // and duplicate keys folded in, because a real on-sale is all four
        // happening in the same second.
        const bucket = i % 20;
        if (bucket < 13) {
          plan.push({ seat: pick(hot, i), ...u, holdSeconds: opts.holdSeconds });
        } else if (bucket < 17) {
          plan.push({
            seat: pick(openZone, i * 7),
            ...u,
            holdSeconds: opts.holdSeconds,
          });
        } else if (bucket < 19) {
          plan.push({
            seat: pick(limitZone, i * 3),
            ...pick(limitCohort, i),
            holdSeconds: opts.holdSeconds,
          });
        } else {
          // i % 20 === 19 lands on 19, 39, 59, ...; dividing by 40 pairs them
          // up, so every key is used exactly twice and the second use is a
          // genuine retry of an identical request.
          const keyIndex = Math.floor(i / 40);
          plan.push({
            seat: pick(idemZone, keyIndex),
            ...pick(users, keyIndex),
            idempotencyKey: `burst-key-${keyIndex}`,
            holdSeconds: opts.holdSeconds,
          });
        }
      }
    }
  }
  return plan;
};

// --- execution -------------------------------------------------------------

const runPlan = async (showId: string, plan: PlannedRequest[]): Promise<Outcome[]> => {
  const outcomes: Outcome[] = new Array(plan.length);
  let cursor = 0;
  let done = 0;
  const startedAt = Date.now();

  const progress = setInterval(() => {
    const pct = ((done / plan.length) * 100).toFixed(0);
    const rps = (done / ((Date.now() - startedAt) / 1000)).toFixed(0);
    process.stderr.write(`\r  ${done}/${plan.length} (${pct}%)  ${rps} req/s   `);
  }, 500);
  progress.unref();

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= plan.length) return;
      const item = plan[i];
      const t0 = process.hrtime.bigint();

      try {
        const res = await json<Record<string, any>>(
          'POST',
          `/shows/${showId}/reserve`,
          {
            seats: [item.seat],
            ...(item.holdSeconds ? { hold_seconds: item.holdSeconds } : {}),
            // Spoofed identity in every single request: the server must ignore
            // it and act as the token's subject. If it ever does not, the
            // per-user-limit check below will notice.
            user_id: 'spoofed-nobody',
          },
          {
            authorization: `Bearer ${item.token}`,
            ...(item.idempotencyKey ? { 'idempotency-key': item.idempotencyKey } : {}),
            'x-request-id': randomUUID(),
          },
        );

        outcomes[i] = {
          status: res.status,
          code: res.body?.error?.code,
          replay: res.body?.idempotent_replay === true,
          seat: item.seat,
          user: item.user,
          reservationId: res.body?.reservation_id,
          idempotencyKey: item.idempotencyKey,
          durationMs: Number(process.hrtime.bigint() - t0) / 1e6,
        };
      } catch (err) {
        // A transport failure is counted as its own category. It is not a 5xx
        // from the service, and pretending otherwise would flatter the result.
        outcomes[i] = {
          status: 0,
          code: `transport:${(err as Error).message.slice(0, 60)}`,
          replay: false,
          seat: item.seat,
          user: item.user,
          durationMs: Number(process.hrtime.bigint() - t0) / 1e6,
        };
      } finally {
        done += 1;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, plan.length) }, worker),
  );
  clearInterval(progress);
  process.stderr.write('\r' + ' '.repeat(60) + '\r');
  return outcomes;
};

// --- reporting -------------------------------------------------------------

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const pad = (label: string, value: string | number): string =>
  `${label.padEnd(30, '.')} ${String(value).padStart(10)}`;

async function main(): Promise<void> {
  console.log('='.repeat(62));
  console.log('  SEAT RESERVATION BURST TEST');
  console.log('='.repeat(62));
  console.log(pad('Target', opts.baseUrl));
  console.log(pad('Scenario', opts.scenario));
  console.log(pad('Total requests', opts.requests));
  console.log(pad('Max in flight', opts.concurrency));
  console.log('');

  // 1. The service must be up and its dependency reachable before we judge it
  //    on anything. A cold start on a free tier can take the better part of a
  //    minute, so we wait rather than reporting a misleading failure.
  process.stdout.write('  waiting for readiness');
  const readyBy = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await json<{ status: string }>('GET', '/readyz');
      if (res.status === 200) break;
    } catch {
      /* still cold */
    }
    if (Date.now() > readyBy) {
      console.error('\n  FAILED: service did not become ready within 120s');
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(' ready\n');

  // 2. Fresh show.
  const seatLabels = Array.from({ length: opts.seats }, (_, i) => `S${i + 1}`);
  const showName = `burst-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const created = await json<{ id: string; total_seats: number }>(
    'POST',
    '/shows',
    {
      name: showName,
      seats: seatLabels,
      price_paise: 25000,
      per_user_limit: opts.perUserLimit,
    },
    { 'x-admin-token': opts.adminToken },
  );
  if (created.status !== 201) {
    console.error('  FAILED to create show:', created.status, created.body);
    process.exit(1);
  }
  const showId = created.body.id;
  console.log(pad('Show id', showId));
  console.log(pad('Seats in hall', created.body.total_seats));
  console.log(pad('Hot seats stormed', opts.hotSeats));
  console.log(pad('Per-user limit', opts.perUserLimit));

  // 3. Identities, minted in bulk so the burst is not preceded by 20k
  //    sequential auth round trips.
  const userCount = Math.min(opts.requests, 20000);
  const minted: Array<{ user: string; token: string }> = [];
  for (let offset = 0; offset < userCount; offset += 5000) {
    const batch = await json<{ tokens: Array<{ user_id: string; token: string }> }>(
      'POST',
      '/auth/tokens/bulk',
      { count: Math.min(5000, userCount - offset), prefix: 'burst' },
    );
    minted.push(...batch.body.tokens.map((t) => ({ user: t.user_id, token: t.token })));
  }
  console.log(pad('Buyers', minted.length));
  console.log('');

  // 4. Go.
  const plan = buildPlan(seatLabels, minted);
  const stormed = new Set(plan.map((p) => p.seat));
  const startedAt = Date.now();
  const outcomes = await runPlan(showId, plan);
  const elapsedMs = Date.now() - startedAt;

  // 5. Outcome distribution.
  const buckets = new Map<string, number>();
  const bump = (k: string) => buckets.set(k, (buckets.get(k) ?? 0) + 1);

  let confirmed = 0;
  let replays = 0;
  let fiveXx = 0;
  let transport = 0;

  for (const o of outcomes) {
    if (o.status === 0) {
      transport += 1;
      bump('transport error');
    } else if (o.status >= 500) {
      fiveXx += 1;
      bump(`${o.status} SERVER ERROR`);
    } else if (o.status === 201 && o.replay) {
      replays += 1;
      bump('201 idempotent replay');
    } else if (o.status === 201) {
      confirmed += 1;
      bump('201 confirmed');
    } else {
      bump(`${o.status} ${o.code ?? 'unknown'}`);
    }
  }

  console.log('-'.repeat(62));
  console.log('  OUTCOME DISTRIBUTION');
  console.log('-'.repeat(62));
  for (const [key, count] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(pad(`  ${key}`, count));
  }

  const latencies = outcomes
    .filter((o) => o.status !== 0)
    .map((o) => o.durationMs)
    .sort((a, b) => a - b);
  console.log('');
  console.log(
    pad('  throughput (req/s)', Math.round(outcomes.length / (elapsedMs / 1000))),
  );
  console.log(pad('  p50 latency (ms)', percentile(latencies, 50).toFixed(1)));
  console.log(pad('  p95 latency (ms)', percentile(latencies, 95).toFixed(1)));
  console.log(pad('  p99 latency (ms)', percentile(latencies, 99).toFixed(1)));
  console.log(pad('  wall clock (s)', (elapsedMs / 1000).toFixed(1)));

  // 6. Correctness checks against the service's own view of the world.
  const state = await json<{
    total_seats: number;
    per_user_limit: number;
    counts: { available: number; held: number; confirmed: number; total: number };
    reconciled: boolean;
    seats: Array<{ seat_number: string; status: string }>;
  }>('GET', `/shows/${showId}`);

  const c = state.body.counts;
  console.log('');
  console.log('-'.repeat(62));
  console.log('  FINAL STATE');
  console.log('-'.repeat(62));
  console.log(pad('  total seats', state.body.total_seats));
  console.log(pad('  available', c.available));
  console.log(pad('  held', c.held));
  console.log(pad('  confirmed', c.confirmed));
  console.log('');
  console.log(
    `  reconciliation: ${c.available} + ${c.held} + ${c.confirmed} = ` +
      `${c.available + c.held + c.confirmed} (expected ${state.body.total_seats})`,
  );

  const failures: string[] = [];

  if (fiveXx > 0) failures.push(`${fiveXx} server errors (5xx) during the burst`);
  if (
    !state.body.reconciled ||
    c.available + c.held + c.confirmed !== state.body.total_seats
  ) {
    failures.push('reconciliation invariant violated');
  }

  // Exactly one winner per stormed seat.
  const winnersPerSeat = new Map<string, number>();
  for (const o of outcomes) {
    if (o.status === 201 && !o.replay) {
      winnersPerSeat.set(o.seat, (winnersPerSeat.get(o.seat) ?? 0) + 1);
    }
  }
  const doubleSold = [...winnersPerSeat.entries()].filter(([, n]) => n > 1);
  if (doubleSold.length > 0) {
    failures.push(
      `DOUBLE SELL: ${doubleSold.map(([s, n]) => `${s} won by ${n}`).join(', ')}`,
    );
  }

  // The number of distinct 201s must equal the number of occupied seats.
  const occupied = c.held + c.confirmed;
  if (occupied !== confirmed) {
    failures.push(
      `occupied seats (${occupied}) != distinct successful reservations (${confirmed})`,
    );
  }

  // Per-user limit, verified from the responses rather than trusting the server.
  const seatsPerUser = new Map<string, Set<string>>();
  for (const o of outcomes) {
    if (o.status === 201 && !o.replay) {
      const set = seatsPerUser.get(o.user) ?? new Set();
      set.add(o.seat);
      seatsPerUser.set(o.user, set);
    }
  }
  const overLimit = [...seatsPerUser.entries()].filter(
    ([, seats]) => seats.size > state.body.per_user_limit,
  );
  if (overLimit.length > 0) {
    failures.push(
      `${overLimit.length} user(s) exceeded the per-user limit of ${state.body.per_user_limit}`,
    );
  }

  // Each idempotency key must map to at most one reservation id.
  const keyToReservations = new Map<string, Set<string>>();
  for (const o of outcomes) {
    if (o.idempotencyKey && o.reservationId) {
      const set = keyToReservations.get(o.idempotencyKey) ?? new Set();
      set.add(o.reservationId);
      keyToReservations.set(o.idempotencyKey, set);
    }
  }
  const forkedKeys = [...keyToReservations.entries()].filter(([, s]) => s.size > 1);
  if (forkedKeys.length > 0) {
    failures.push(`${forkedKeys.length} idempotency key(s) produced >1 reservation`);
  }

  console.log('');
  console.log('-'.repeat(62));
  console.log('  CORRECTNESS CHECKS');
  console.log('-'.repeat(62));
  const check = (ok: boolean, label: string) =>
    console.log(`  [${ok ? ' PASS ' : ' FAIL '}] ${label}`);

  check(fiveXx === 0, `zero 5xx responses (saw ${fiveXx})`);
  check(
    doubleSold.length === 0,
    `no seat sold twice (${stormed.size} seats contested)`,
  );
  check(
    state.body.reconciled &&
      c.available + c.held + c.confirmed === state.body.total_seats,
    'available + held + confirmed == total_seats',
  );
  check(occupied === confirmed, 'occupied seats match distinct 201s');
  check(overLimit.length === 0, `per-user limit of ${state.body.per_user_limit} held`);
  check(
    forkedKeys.length === 0,
    `each idempotency key -> one reservation (${replays} replays)`,
  );
  if (transport > 0) {
    console.log(
      `  [ NOTE ] ${transport} client-side transport error(s); lower --concurrency if this is high`,
    );
  }

  console.log('');
  console.log('='.repeat(62));
  if (failures.length === 0) {
    console.log('  RESULT: PASSED');
    console.log('='.repeat(62));
    await agent.close();
    process.exit(0);
  }
  console.log('  RESULT: FAILED');
  for (const f of failures) console.log(`    - ${f}`);
  console.log('='.repeat(62));
  await agent.close();
  process.exit(1);
}

main().catch(async (err) => {
  console.error('\nburst script crashed:', err);
  await agent.close();
  process.exit(1);
});
