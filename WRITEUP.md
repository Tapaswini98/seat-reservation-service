# Design write-up

## 1. The atomic decision

One PostgreSQL transaction at READ COMMITTED, in
[`reservation.repository.ts`](src/models/repositories/reservation.repository.ts).

**The seat row is the resource.** Exactly one row per `(show_id, seat_number)`,
unique-constrained, with a NOT NULL three-valued status. Everything follows
from that — including the reconciliation invariant, which becomes a sum over
an enum across N rows rather than something the application maintains.

```sql
BEGIN;
-- 1. per-(show,user) advisory lock, folded into the show read
SELECT id, price_paise, per_user_limit FROM shows
 WHERE id = $1 AND pg_advisory_xact_lock(hashtextextended($1||':'||$2, 0)) IS NOT NULL;

-- 2. lock the seats in a deterministic order
SELECT id, seat_number, status FROM seats
 WHERE show_id = $1 AND seat_number = ANY($2) ORDER BY seat_number ASC FOR UPDATE;

-- 3. quota check, sound because of (1)
-- 4. insert reservation + reservation_seats

-- 5. the compare-and-swap
UPDATE seats SET status = $3, reservation_id = $4, owner_user_id = $5, ...
 WHERE show_id = $1 AND seat_number = ANY($2) AND status = 'available'
 RETURNING id;                        -- row count must equal seats requested

-- 6. mark the idempotency key completed, in this same transaction
COMMIT;
```

**Why it's race-free**, strongest reason first:

1. **Step 5 is a compare-and-swap.** `AND status = 'available'` is the guard.
   Under READ COMMITTED, a writer that blocks on a concurrently-updated row
   re-evaluates its `WHERE` against the committed version once the other
   transaction ends — so two transactions cannot both get a row back. This is
   the actual guarantee; everything else improves the *loser's* experience,
   not the winner's correctness.
2. **Step 2 takes the row locks up front**, so the loser blocks, then reads a
   real status and declines with a precise reason instead of inferring one
   from a row count.
3. **One row per seat.** No arrangement of this data owns a seat twice.

A read-then-write fails because the read's snapshot is stale by the time the
write lands. Step 5 has no gap: predicate and mutation are one statement.

**Deadlock.** The only multi-row lock set is step 2, always `ORDER BY
seat_number ASC` — Postgres puts `LockRows` above `Sort`, so locks really are
taken in sorted order. Cancel and confirm use the same order; the sweeper uses
`FOR UPDATE SKIP LOCKED` so it can never block a buyer. Global order is
**advisory(show,user) → seats ascending**, which admits no cycle: advisory
keys are per-user, so two users never contend on one. `40P01`/`40001`/`55P03`
are still retried 3× with full jitter — defence in depth, and it means
contention can never surface as a 5xx. A test runs 60 rounds of `[D1,D2]`
against `[D2,D1]` and sees zero deadlocks.

**The per-user limit needs its own mechanism.** Row locks on seats do nothing
here: two parallel requests from one user for *different* seats both read "3
held" and both insert — classic write-skew. The advisory lock on
`(show_id, user_id)` serialises one user's attempts. It's transaction-scoped,
so there's no unlock to leak on an error path, and because the key is
per-user, 20,000 distinct buyers never contend on it.

**The fast path.** A screening read runs before the transaction opens: one
index-only query checking whether the seats are gone *and* whether the caller
is already at their limit. It can only ever **decline**, never allocate —
which is what makes it safe, since the authoritative decision is still the
guarded UPDATE. Its one wrong outcome is declining a seat freed microseconds
earlier, costing that caller a retry.

Without it, every loser in a hot-seat storm opens a transaction and queues
behind every other loser. Same hardware, same 5,000-request burst:

| | throughput | p50 | p99 |
|---|---|---|---|
| Before | 302 req/s | 450 ms | 726 ms |
| After | 2,929 req/s | 63 ms | 150 ms |

**Multi-seat: all-or-nothing.** `["A12","A13"]` with only A12 free reserves
nothing and returns `409 seat_taken` naming A13. Best-effort was rejected
because it makes the amount charged depend on who won a race — a terrible
property for something that takes money — and leaves the client unable to tell
whether it got one seat or two.

---

## 2. Idempotency

Stored in `idempotency_keys`, unique on `(user_id, idempotency_key)` —
deliberately **not** scoped by show. One key means one operation; reusing it
for a different show is the same violation as reusing it for different seats.

Hashed over a canonical form: `{show_id, sorted seats, hold_seconds}`. Seats
are sorted because `["A12","A13"]` and `["A13","A12"]` are the same request.

```
TX_A (own transaction, commits immediately)
  INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id
    got a row  -> we are the original; proceed
    got none   -> read the existing row:
         hash differs      -> 409 idempotency_key_reuse
         completed         -> replay the stored response verbatim
         declined          -> replay the stored decline
         in_progress       -> wait (backing off) up to IDEMPOTENCY_WAIT_MS,
                              then replay; on timeout 409 request_in_flight

TX_B  the reservation transaction, which flips the key to 'completed' and
      stores the response IN THE SAME TRANSACTION

TX_C  on a decline, a short UPDATE recording status='declined' + the body
```

**Why the key is committed before the work.** Written inside the reservation
transaction, a declined attempt would roll the key away with it — and "same
key, different body → 409" would silently stop working the moment anything
went wrong. The key has to outlive a failed attempt.

**Exactly-once** comes from `INSERT … ON CONFLICT DO NOTHING … RETURNING`:
the unique index decides who the original is, the loser blocks on it until the
winner commits, and the returned row tells each caller which it is. No
read-then-write anywhere. Phase 2 running on the same `EntityManager` as the
reservation insert means the stored response and the reservation commit
atomically — they cannot disagree.

**Parallel duplicates.** 50 simultaneous uses of one key produce one
reservation. The duplicates find `in_progress` and wait rather than conflicting
immediately — a client that fired twice should get the original reservation
back, not a confusing 409.

`IDEMPOTENCY_WAIT_MS` must exceed p99 reservation latency, and the burst is how
you discover whether it does. At 250ms, 29% of duplicates in a local 20k burst
timed out into `request_in_flight`; at 2000ms, none did. The same burst against
the free Render instance — p99 ~3.5s rather than ~0.9s — surfaced two again, so
the deployed value is 6000ms. It is environment-specific by nature, which is
why it's configuration and not a constant.

**Declines are replayed too.** If a key's first attempt lost a seat, a retry of
that key gets the identical 409 even if the seat has since been freed. A retry
must never turn a "no" into a "yes" by racing — the same class of bug that makes
retried payments double-charge. A *fresh* key for the same user does succeed.

**If a phase is lost:** TX_C lost → the key stays `in_progress` and the TTL
sweeper reaps it, so a retry is re-evaluated (harmless). A non-domain failure
deletes the key, so an honest retry isn't blocked by a request that never got
an answer.

---

## 3. Holds, expiry and ownership

Both models the brief offers, through one code path. `POST /reserve` with no
`hold_seconds` confirms outright (matching the brief's example response); with
`hold_seconds` it creates a `held` reservation with an `expires_at`, promotable
via `/confirm`. Either can be cancelled by its owner.

The sweeper runs every 5s, bounded per pass, re-entrancy guarded, in a single
statement using `FOR UPDATE SKIP LOCKED` — it must never block a buyer, and two
instances must never fight.

**A release can never resurrect a seat sold to someone else.** Every release —
sweeper and cancel alike — is guarded on `reservation_id = <this reservation>`.
A seat already re-sold carries a different `reservation_id` and simply isn't
matched. A test lets a hold expire, lets a second buyer take the seat, then
cancels the stale hold and asserts the seat still belongs to the second buyer.

Confirm is guarded on `status = 'held'` and the row count must equal
`seat_count`, so a hold the sweeper released a microsecond earlier fails with
`reservation_expired` rather than half-promoting. A failed sweep is
self-healing: the next tick picks the same rows up.

A `CHECK` constraint makes a half-written seat impossible to commit — an
occupied seat always names its owner and reservation, an available one never
does, only a held seat has a `held_until`.

**Identity is the JWT subject, everywhere.** No handler reads a user id from a
request body; `CurrentUser` is the only source, and it reads the verified
token. A spoofed `user_id` in the body is *stripped* by the ValidationPipe
(`whitelist: true, forbidNonWhitelisted: false`) rather than rejected — a 400
would confirm to an attacker that the field is recognised, and the requirement
is that a spoofed identity can only ever act as the token's user, not that it
errors. A test asserts the reservation and the seat's `owner_user_id` both
come out as the attacker, never the victim.

**Cancel and confirm are owner-only, and a non-owner gets 404, not 403.**
Ownership is re-checked against the row locked `FOR UPDATE`, not against the
unlocked read used to find the show id. The 404 is deliberate: 403 would
confirm that a reservation id exists, which makes ids enumerable by probing.
The message is byte-identical to a genuine not-found, so the two are
indistinguishable from outside. The brief requires only that a non-owner
cannot cancel; the status code is my choice, and hiding existence is the
safer default for a resource keyed by a guessable-looking id.

---

## 4. Consistency vs availability under a partition

**This service chooses consistency.** If the database is unreachable we cannot
know whether a seat is free, so we refuse to decide:

- `/readyz` runs a real query and **fails closed with 503**, draining us from
  the load balancer.
- `/healthz` never touches the database — a blip must not get a healthy process
  killed and turn a dependency outage into an outage *plus* a restart loop.
- A reserve during an outage returns **503 `dependency_unavailable`** with
  `Retry-After`.

That last distinction is where the "zero 5xx" bar needs reading carefully. The
bar is about **declines**: a seat that's gone, or a user over their limit, is a
business answer and must be 4xx. A database we can't reach is not an answer at
all. Returning 429 there would tell the client "retry, you might win" — under a
partition, exactly the lie that produces a double-sell.

| Condition | Status | Reasoning |
|---|---|---|
| Seat gone, over limit, key reused | 409 | Business outcome |
| Pool saturated (clears in ms) | 429 `service_busy` | Shed load; retry helps |
| Database unreachable | 503 `dependency_unavailable` | Can't decide; retry doesn't help yet |
| Anything else | 500 | A real bug, and we want to see it |

Buffering reservations and reconciling later would mean selling seats we can't
prove are free — two people in seat A12 on the night. Availability is the right
trade for a shopping cart; it's the wrong trade for a system of record.

The single database is the honest limit: one Postgres is a single point of
failure. The next step is a managed primary with a standby and automated
failover, which buys durability and recovery time — not partition tolerance.
Writes still stop during a failover, by design.

---

## 5. What I'd get paged for at 2am

| Page | Why |
|---|---|
| `seats_reconciliation_ok == 0` | The invariant broke. This is the one that means someone has two tickets to the same seat. |
| `rate(http_server_errors_total) > 0` for 2m | We're failing, not declining. |
| `/readyz` failing across all instances | Database gone; we're selling nothing. |
| `db_pool_waiting_requests` high, `service_busy` climbing | Pool saturation — the warning that precedes a bad on-sale. |
| p99 `reservation_duration_seconds` > ~1s | Lock contention or a plan regression. |
| `reservation_tx_retries_total{sqlstate="40P01"}` climbing | Deadlocks should be ~zero. Means my lock-ordering reasoning is wrong somewhere. |

Ticket, don't page: `holds_expired_total` spiking (a checkout funnel problem),
`idempotent_replay` climbing (a client retrying too eagerly).

Instrumentation sits in Fastify `onRequest`/`onResponse` hooks rather than a
Nest interceptor, because `onResponse` fires for *every* reply — including ones
written by the exception filter and Fastify's own 404 handler. An interceptor
only sees requests that reach a handler, which is the wrong coverage when the
thing you're proving is "zero 5xx across the whole burst".

---

## 6. AI usage

**What I directed.** Every architectural and concurrency decision: single
Postgres over Redis/Kafka; the seat row as the resource; CAS-on-status as the
primary guarantee with row locks for decline quality; the advisory lock
specifically for the per-user write-skew; ascending seat order for deadlock
freedom; all-or-nothing multi-seat; the three-phase idempotency protocol and
the argument that the key must be committed before the work; the
409-vs-429-vs-503 taxonomy; scrape-time gauges so metrics can't drift from the
API. Those are the decisions I expect to defend, and they're mine.

**What AI did well.** The mechanical layers, quickly and accurately: NestJS
module wiring, DTOs and validation, Dockerfile and deploy config, the
prom-client registry, the burst script's worker pool and reporting, and first
drafts of most tests. Roughly 70% of the lines, close to 0% of the decisions.

**Where I had to override it** — three worth naming, because each was a
plausible-looking answer that was wrong:

1. **TypeORM returns `[rows, rowCount]` for UPDATE/DELETE, not `rows`.** The
   generated CAS check compared `updated.length` against an array of length 2
   and declined *every* reservation, including on an empty show. Caught by my
   own safety-net log on the first end-to-end run, not by reading the code.
   Now centralised in `rowsOf()` with a comment on why it matters.
2. **It built locally and not in Docker.** `tsconfig.json` includes `test/` and
   `scripts/`, so tsc rooted at `.` and emitted `dist/src/main.js`, while the
   image copies only `src` and emitted `dist/main.js`. Exactly the clean-clone
   failure the brief warns about, and it only surfaced because I actually ran
   `docker compose up` instead of trusting `npm run build`.
3. **Performance, and the burst plan itself.** The first implementation did 302
   req/s because every loser queued on the winner's row lock; the fast path and
   the argument for why a decline-only unlocked read is safe were mine.
   Separately, my first `mixed` burst reported zero idempotent replays and zero
   limit declines — not because the server was wrong, but because `seat_taken`
   is checked first and masked both. I rezoned the hall so each cohort has
   seats it can actually reach.

I also rejected suggestions to add Redis for seat locking (a second source of
truth for the one thing that must have exactly one) and `SERIALIZABLE`
isolation (makes the CAS redundant while adding retry storms under exactly the
contention we care about).

---

## 7. Limits and what's next

**Known limits.** One database, one writer — vertical scale only. A single very
hot seat is a serialisation point by definition; the fast path removes the
losers from that queue, which is most of the win available, but not the
physics. Free-tier deploy spins down when idle and runs the 20k burst at ~106
req/s versus ~1,334 on a local container — every correctness check passes
identically in both, which is the result that matters. The auth shim has no
user store: intentional, clearly marked, not something I'd ship.

**Next, in order.**

1. **Payments and a real hold lifecycle** — `held → payment_pending →
   confirmed`, with the provider's idempotency key threaded through ours and
   compensation on a failed capture. Today `confirmed` means allocated, not paid.
2. **Admission control at the edge** — for a genuine on-sale, a virtual waiting
   room is the right answer to 20k simultaneous buyers. Smoothing arrival beats
   optimising the lock.
3. **Read scaling** — `GET /shows/{id}` on a 20k-seat hall is the expensive
   read; a replica plus a short-TTL seat-map cache, with the reservation path
   staying on the primary.
4. **Partitioning by show** — the natural shard key. Nothing in the reservation
   transaction crosses shows, so this is mechanical.
5. **Tracing** — OpenTelemetry spans around the transaction, so a slow
   reservation shows *which* statement waited on a lock.
6. **Chaos in CI** — run the burst against an instance being restarted and
   failed over mid-flight, then assert the invariant. The suite proves
   correctness under contention, not under failure.
