# Design write-up

## 1. The atomic decision

**Where it lives:** one PostgreSQL transaction at READ COMMITTED, in
[`reservation.repository.ts`](src/models/repositories/reservation.repository.ts).

The seat row *is* the resource. There is exactly one row per
`(show_id, seat_number)`, enforced by a unique constraint, and its `status` is
a NOT NULL three-valued enum. Everything else follows from that.

```sql
BEGIN;
-- 1. per-(show, user) advisory lock, folded into the show read
SELECT id, price_paise, per_user_limit FROM shows
 WHERE id = $1 AND pg_advisory_xact_lock(hashtextextended($1||':'||$2, 0)) IS NOT NULL;

-- 2. lock the requested seats in a deterministic order
SELECT id, seat_number, status FROM seats
 WHERE show_id = $1 AND seat_number = ANY($2) ORDER BY seat_number ASC FOR UPDATE;

-- 3. quota, sound because of the lock taken in (1)
SELECT count(*) FROM seats
 WHERE show_id = $1 AND owner_user_id = $2 AND status <> 'available';

-- 4. reservation + reservation_seats rows

-- 5. the compare-and-swap
UPDATE seats SET status = $3, reservation_id = $4, owner_user_id = $5, ...
 WHERE show_id = $1 AND seat_number = ANY($2) AND status = 'available'
 RETURNING id;                       -- row count must equal the seats requested

-- 6. mark the idempotency key completed, in this same transaction
COMMIT;
```

### Why it is race-free

Three independent mechanisms, strongest first:

1. **Step 5 is a compare-and-swap.** `AND status = 'available'` is the guard.
   Under READ COMMITTED, a writer that blocks on a concurrently-updated row
   re-evaluates its `WHERE` clause against the committed version once the
   other transaction ends. So even with every explicit lock removed, two
   transactions cannot both get a row back from this statement. This is the
   actual guarantee. Everything else makes the *loser's* experience good, not
   the winner's correctness.
2. **Step 2 takes the row locks up front**, so the loser blocks, then reads a
   real status and declines with a precise reason ("A12 is taken") instead of
   inferring it from a row count.
3. **One row per seat.** There is no arrangement of this data in which a seat
   is owned twice. This also makes `available + held + confirmed == total_seats`
   *structurally* true — a sum over a NOT NULL enum across N rows — rather than
   an invariant we maintain and hope stays maintained.

A read-then-write (`is A12 free? ok, take it`) fails because the read's
snapshot is stale by the time the write lands. Step 5 has no gap: the predicate
and the mutation are the same statement.

### Deadlock, for multi-seat requests

The only multi-row lock set is step 2, always acquired `ORDER BY seat_number
ASC`. PostgreSQL puts the `LockRows` node above the `Sort`, so locks really are
taken in sorted order. Cancel and confirm use the same ascending order, and the
expiry sweeper uses `FOR UPDATE SKIP LOCKED` so it can never block a buyer or
be blocked by one.

The global lock order is **advisory(show, user) → seat rows ascending**, which
admits no cycle: advisory keys are per-user so two different users never
contend on one, and seats are always ascending. `cancel` learns the show id
from an unlocked peek specifically so it can take the advisory lock *before* any
row lock and stay in that order.

We still catch `40P01`, `40001` and `55P03` and retry up to three times with
full jitter. That is defence in depth, not the plan — and it means contention
can never surface as a 5xx. A `DomainError` is a decision and is never retried.
Test `does not deadlock when two users fight over the same pair in opposite
order` runs 60 rounds of `[D1,D2]` against `[D2,D1]` and sees zero.

### The per-user limit needs its own mechanism

Row locks on seats do nothing here. Two parallel requests from one user for
*different* seats would both read "3 held" and both insert — a classic
write-skew. `pg_advisory_xact_lock` on `(show_id, user_id)` serialises one
user's concurrent attempts. It is transaction-scoped, so there is no unlock
call to leak on an error path, and because the key is per-user, the
20,000-distinct-buyers case never contends on it at all.

### The fast path

A screening read runs before the transaction opens: one index-only query that
checks whether the seats are already gone *and* whether the caller is already
at their limit. It can only ever **decline**, never allocate, which is what
makes it safe — the authoritative decision is still the guarded UPDATE. Its one
wrong outcome is declining a seat freed microseconds earlier, costing that
caller a retry.

This matters enormously under contention. Without it, in a hot-seat storm every
loser opens a transaction and queues behind every other loser on the winner's
row lock. Measured on the same hardware, same 5,000-request hot-seat burst:

| | throughput | p50 | p99 |
|---|---|---|---|
| Before | 302 req/s | 450 ms | 726 ms |
| After | 2,929 req/s | 63 ms | 150 ms |

### Multi-seat semantics: all-or-nothing

A request for `["A12","A13"]` where only A12 is free reserves **nothing** and
returns `409 seat_taken` naming A13. Best-effort was rejected because it makes
the amount charged depend on who won a race, which is a terrible property for
something that takes money, and it makes the client's retry logic ambiguous
(did I get one seat or two?). Enforced by the row-count check on step 5 inside
the transaction, so partial allocation cannot survive a rollback.

---

## 2. Idempotency

**Where the key is stored:** `idempotency_keys`, unique on
`(user_id, idempotency_key)` — deliberately *not* scoped by show. One key means
one operation; reusing it for a different show is the same violation as reusing
it for different seats. The key may arrive as the `Idempotency-Key` header or
an `idempotency_key` body field; the header wins.

**What is hashed:** sha256 over a canonical form — `{show_id, sorted seats,
hold_seconds}`. Seats are sorted because `["A12","A13"]` and `["A13","A12"]`
are the same request, so reordering them must not be read as a different body.

### Three phases, and why the key is committed first

```
TX_A (own transaction, commits immediately)
  INSERT INTO idempotency_keys (..., status='in_progress')
    ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id
  returned a row  -> we are the original; proceed
  returned none   -> read the existing row:
       hash differs            -> 409 idempotency_key_reuse
       status = completed      -> replay the stored response verbatim
       status = declined       -> replay the stored decline
       status = in_progress    -> wait (backing off) up to IDEMPOTENCY_WAIT_MS,
                                  then replay; on timeout 409 request_in_flight

TX_B  the reservation transaction, which flips the key to 'completed'
      and stores the response IN THE SAME TRANSACTION

TX_C  on a decline, a short UPDATE recording status='declined' + the body
```

**Why not write the key inside the reservation transaction?** Because a
declined attempt rolls back, which would roll the key away with it — and
"same key, different body → 409" would silently stop working the moment
anything went wrong. The key has to outlive a failed attempt.

**Exactly-once** comes from `INSERT … ON CONFLICT DO NOTHING … RETURNING`.
There is no read-then-write anywhere in this path: the unique index decides who
the original is, the loser blocks on it until the winner commits, and
`RETURNING` tells each caller which one it is. Phase 2 running on the same
`EntityManager` as the reservation insert means the stored response and the
reservation commit atomically — they can never disagree.

**Parallel duplicates.** 50 simultaneous uses of one key produce one
reservation (test: `creates exactly one reservation for 50 parallel uses of one
key`). The 49 duplicates find `in_progress` and wait, backing off, rather than
immediately conflicting — a client that fired the same key twice should get
the original reservation, not a confusing 409. `IDEMPOTENCY_WAIT_MS` defaults
to 2000 and must exceed p99 reservation latency; at 250ms, 29% of duplicates in
a 20k burst timed out into `request_in_flight`, at 2000ms none did.

**Declines are replayed too.** If a key's first attempt lost a seat, a retry of
that key gets the identical 409 even if the seat has since been freed. A retry
must never be able to turn a "no" into a "yes" by racing — that is the same
class of bug that makes retried payments double-charge. A *fresh* key for the
same user does succeed, because the seat really is free.

**Failure handling.** If TX_C is lost the key stays `in_progress` and the TTL
sweeper reaps it; the failure mode is a retry being re-evaluated, which is
harmless. If the reservation fails for a non-domain reason the key is deleted,
so an honest retry is not permanently blocked by a request that never got an
answer.

---

## 3. Holds and expiry

Both models the brief offers, through one code path. `POST /reserve` with no
`hold_seconds` confirms outright (matching the brief's `status: "confirmed"`
example); with `hold_seconds` it creates a `held` reservation with an
`expires_at`, promotable via `/confirm`. Either can be cancelled by its owner.

The sweeper runs every 5s, bounded per pass, with a re-entrancy guard, in a
single statement:

```sql
WITH expired AS (
  SELECT id FROM reservations WHERE status='held' AND expires_at < now()
  ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
), released AS (
  UPDATE seats s SET status='available', reservation_id=NULL, owner_user_id=NULL, …
  FROM expired e WHERE s.reservation_id = e.id AND s.status='held' RETURNING s.id
), closed AS (
  UPDATE reservations r SET status='expired' FROM expired e
  WHERE r.id = e.id AND r.status='held' RETURNING r.id
) SELECT …
```

**A release can never resurrect a seat sold to someone else.** Every release —
sweeper and cancel alike — is guarded on `reservation_id = <this reservation>`.
A seat already re-sold carries a different `reservation_id` and is simply not
matched. Test: `never resurrects a seat already confirmed to someone else` lets
a hold expire, lets a second buyer take the seat, then cancels the stale hold
and asserts the seat is still confirmed to the second buyer.

Confirm is guarded on `status = 'held'` and the row count must equal
`seat_count`, so a hold the sweeper released a microsecond earlier fails with
`reservation_expired` rather than half-promoting. A failed sweep is
self-healing: the next tick picks the same rows up.

There is also a `CHECK` constraint making a half-written seat impossible to
commit: an occupied seat always names its owner and reservation, an available
one never does, and only a held seat has a `held_until`.

---

## 4. Consistency vs availability under a partition

**This service chooses consistency, and I would make the same call again.**

If the database is unreachable we cannot know whether a seat is free, so we
refuse to decide. Concretely:

- `/readyz` runs a real query and **fails closed with 503**, so the load
  balancer drains us.
- `/healthz` never touches the database — a DB blip must not get a healthy
  process killed and turn a dependency outage into an outage *plus* a restart
  loop.
- A reserve during an outage returns **503 `dependency_unavailable`** with
  `Retry-After`, not 429 and not a generic 500.

That last distinction is deliberate and it is where the "zero 5xx" bar needs
reading carefully. The bar is about **declines**: a seat that is gone, or a user
over their limit, is a business answer and must be a 4xx. A database we cannot
reach is not an answer at all. Returning 429 there would tell the client "retry,
you might win", which under a partition is exactly the lie that produces a
double-sell. So:

| Condition | Status | Reasoning |
|---|---|---|
| Seat gone, over limit, key reused | 409 | Business outcome |
| Pool saturated (clears in ms) | 429 `service_busy` | Shed load, retry helps |
| Database unreachable | 503 `dependency_unavailable` | We cannot decide; retry does not help yet |
| Anything else | 500 | A real bug, and we want to see it |

The alternative — buffering reservations and reconciling later — would mean
selling seats we cannot prove are free. For assigned seating that produces two
people in seat A12 on the night, which is categorically worse than a few
minutes of "try again". Availability is the right trade for a cart; it is the
wrong trade for a system of record.

The single-database design is also the honest limit here: one PostgreSQL is a
single point of failure. The next step is a managed primary with a standby and
automated failover, which buys durability and recovery time, not partition
tolerance. Writes still stop during a failover, by design.

---

## 5. Observability

**Metrics.** Counters for confirmations, declines labelled by reason
(`seat_taken`, `per_user_limit`, `idempotent_replay`, …), cancellations,
expiries and transaction retries by SQLSTATE; histograms for reservation and
HTTP duration; gauges for seats by state, pool saturation, and
`seats_reconciliation_ok`.

The seat gauges are **computed from the database at scrape time** (1s cache),
not incremented alongside writes. That makes "metrics reconcile with the API"
true by construction, because both read the same rows. A gauge you remember to
decrement is a gauge that eventually drifts, and a drifting gauge during an
on-sale is worse than no gauge. `seats_reconciliation_ok` compares the three
buckets against the show's *declared* `total_seats` rather than against their
own sum — otherwise the check is circular and can never fail.

Label cardinality is bounded on purpose: gauges are emitted for the 20 most
recent shows only, and no metric is ever labelled by user, seat or reservation.

**Logs.** pino JSON on stdout with a `request_id` taken from an inbound
`X-Request-Id` (echoed on the response) and propagated through
`AsyncLocalStorage`. Instrumentation sits in Fastify `onRequest`/`onResponse`
hooks rather than a Nest interceptor, because `onResponse` fires for *every*
reply — including ones written by the exception filter and Fastify's own 404
handler. An interceptor only sees requests that reach a handler, which is
precisely the wrong coverage when the thing you are proving is "zero 5xx across
the whole burst". Successes are sampled 1-in-N; every non-2xx is logged in full.

### What I would want to be paged for at 2am

| Page | Why |
|---|---|
| `seats_reconciliation_ok == 0` | The invariant broke. This is the one that means someone has two tickets to the same seat. Wake me immediately. |
| `rate(http_server_errors_total) > 0` for 2m | We are failing, not declining. |
| `/readyz` failing across all instances | Database gone; we are selling nothing. |
| `db_pool_waiting_requests` high, or `service_busy` rate climbing | Pool saturation — the warning that precedes a bad on-sale. |
| p99 `reservation_duration_seconds` over ~1s | Lock contention or a plan regression. |
| `reservation_tx_retries_total{sqlstate="40P01"}` climbing | Deadlocks, which should be ~zero. Means my lock-ordering reasoning is wrong somewhere. |

Ticket, don't page: `holds_expired_total` spiking (a checkout funnel problem),
`idempotent_replay` rate climbing (a client retrying too eagerly).

---

## 6. AI usage

Honest split, since you asked for specifics.

**What I directed.** All of the architecture and every concurrency decision:
single Postgres over Redis/Kafka, the seat row as the resource, CAS-on-status
as the primary guarantee with row locks for decline quality, the advisory lock
specifically for the per-user write-skew, ascending seat order for deadlock
freedom, all-or-nothing multi-seat, the three-phase idempotency protocol and
the reasoning that the key must be committed before the work, the
409-vs-429-vs-503 taxonomy, and scrape-time gauges so metrics cannot drift from
the API. Those are the decisions I expect to be asked to defend, and they are
mine.

**What AI did well.** Fast, accurate generation of the mechanical layers:
NestJS module wiring, DTOs and validation decorators, the Dockerfile and
compose/Render config, the prom-client registry, the burst script's worker pool
and reporting, and the first draft of most tests. Rough estimate: it wrote
perhaps 70% of the lines and close to 0% of the decisions.

**Where I had to override it.** Three worth naming, because they are the places
a plausible-looking answer was wrong:

1. **`TypeORM` returns `[rows, rowCount]` for UPDATE/DELETE, not `rows`.** The
   generated CAS check compared `updated.length !== seats.length` against an
   array of length 2 and declined *every* reservation, including on an empty
   show. Caught by the safety-net log the first time I ran it end to end, not
   by reading the code. Now centralised in `rowsOf()` with a comment explaining
   exactly why it matters.
2. **The build worked locally and not in Docker.** `tsconfig.json` includes
   `test/` and `scripts/`, so locally tsc rooted at `.` and emitted
   `dist/src/main.js`, while the image copies only `src` and emitted
   `dist/main.js`. This is the exact "clean clone fails to build" failure the
   brief warns about, and it only showed up because I actually ran
   `docker compose up` rather than trusting `npm run build`. Fixed with an
   explicit `rootDir` in `tsconfig.build.json`.
3. **Performance and the burst plan.** The first implementation did 302 req/s
   on a hot-seat storm because every loser queued on the winner's row lock; the
   fast path was my addition, as was the argument for why a decline-only
   unlocked read cannot compromise correctness. Separately, my first `mixed`
   burst plan reported zero idempotent replays and zero limit declines — not
   because the server was wrong, but because `seat_taken` is checked first and
   masked both. I rezoned the hall so each cohort has seats it can actually
   reach.

I also deliberately rejected AI suggestions to add Redis for seat locking and
to use `SERIALIZABLE` isolation. Redis introduces a second source of truth for
the one thing that must have exactly one; `SERIALIZABLE` would make the CAS
redundant while adding retry storms under exactly the contention we care about.

---

## 7. Limitations, and what I would do next

**Known limits.**

- One database, one writer. Vertical scale only; ceiling is roughly
  `max_connections` × transaction rate. Measured ~1,300–2,900 req/s on a laptop
  Docker Postgres depending on scenario; a real instance does considerably more.
- A single very hot seat is still a serialisation point by definition — the
  winners for one seat must queue. The fast path removes the losers from that
  queue, which is most of the win available, but it cannot remove the physics.
- Free-tier deploy: the instance spins down when idle, so the first request
  after a quiet period pays a cold start.
- The auth shim has no user store. Intentional for this exercise, clearly
  marked, and not something I would ship.
- `reservation_seats` duplicates `seat_number` for convenience; a stricter
  schema would read it through the join.

**Next, in order.**

1. **Payments and a real hold lifecycle.** `held → payment_pending → confirmed`
   with the payment provider's idempotency key threaded through ours, and
   compensation on a failed capture. Right now `confirmed` means "allocated",
   not "paid".
2. **Admission control at the edge.** For a genuine on-sale, a queue in front
   (virtual waiting room) is the correct answer to 20k simultaneous buyers —
   smoothing arrival beats optimising the lock.
3. **Read scaling.** `GET /shows/{id}` on a 20k-seat hall is the expensive read;
   a replica plus a short-TTL cache of the seat map, with the reservation path
   staying on the primary.
4. **Partitioning by show.** The natural shard key. Nothing in the reservation
   transaction crosses shows, so this is mechanical when one database stops
   being enough.
5. **Tracing.** OpenTelemetry spans around the transaction, so a slow
   reservation shows *which* statement waited on a lock instead of just
   reporting a high p99.
6. **Chaos in CI.** Run the burst against an instance that is being restarted
   and failed over mid-flight, and assert the invariant afterwards. The current
   suite proves correctness under contention, not under failure.
