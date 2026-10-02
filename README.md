# Seat Reservation Service

Sells assigned seats for an event under heavy contention. The whole design goal
is that a seat is never sold twice, a user never exceeds their limit, and a
retried request never books twice — while tens of thousands of buyers hit the
same show in the same second.

**Live URL:** https://seat-reservation-service-mcov.onrender.com
**Metrics:** [`/metrics`](https://seat-reservation-service-mcov.onrender.com/metrics) ·
**Health:** [`/healthz`](https://seat-reservation-service-mcov.onrender.com/healthz),
[`/readyz`](https://seat-reservation-service-mcov.onrender.com/readyz)

> Render free tier: the instance spins down after ~15 minutes idle, so the
> first request may take ~50s. The burst script waits for readiness. The free
> PostgreSQL instance expires 30 days after creation (2026-11-01).

Stack: NestJS 11 (Fastify) · PostgreSQL 16 · TypeORM (schema + migrations, raw
SQL on the reservation path) · prom-client · pino.

```
src/
  models/          entities, repositories, migrations, data source
  modules/         auth, show, reservation, health, metrics, database
  shared/          enums, exceptions, guards, decorators, logger, helpers
  config/          environment loading
```

The atomic reservation transaction lives in
[`models/repositories/reservation.repository.ts`](src/models/repositories/reservation.repository.ts);
everything the design hinges on is commented there.

---

## Run it

### Everything in Docker (what the deploy does)

```bash
docker compose up -d --build
curl localhost:3000/readyz
```

Migrations run from the container entrypoint before the server starts, so a
clean checkout and the deployed instance get identical DDL.

### Locally against the dockerised database

```bash
cp .env.example .env
docker compose up -d postgres     # host port 5433, to avoid clashing with a local pg
npm ci
npm run migrate:dev
npm run start:dev
```

### Tests

```bash
make test          # starts a disposable postgres on :55432, then runs the suite
```

30 integration tests against a real PostgreSQL — hot-seat storms, parallel
idempotency, per-user limits, hold expiry, ownership, and the reconciliation
invariant after every concurrent scenario.

---

## The burst script

One command, against anything:

```bash
./burst.sh https://your-service.example.com
```

Defaults to 20,000 requests at 300 in flight with the `mixed` scenario. It
mints its own buyers, creates its own show, runs the storm, then checks the
result against the service's own view of the world and exits non-zero if
anything is wrong.

```bash
./burst.sh <URL> --scenario=hot-seat   --requests=20000 --concurrency=300
./burst.sh <URL> --scenario=stampede   --hot-seats=10
./burst.sh <URL> --scenario=user-limit --requests=2000
./burst.sh <URL> --scenario=idempotent --requests=4000
./burst.sh <URL> --requests=20000 --concurrency=300 --seats=500 --hot-seats=10
```

| Scenario | What it does |
|---|---|
| `mixed` (default) | Hot-seat storm + cold-seat buyers + an over-limit cohort + duplicate keys, all at once. The hall is split into zones so every outcome class is actually exercised rather than being masked by seat-taken. |
| `hot-seat` | Every single buyer fights over one seat. Exactly one may win. |
| `stampede` | Everyone spread across the N hottest seats. |
| `user-limit` | A cohort of 25 buyers firing far more parallel reserves than their quota. |
| `idempotent` | Every key used four times, so three in four requests are retries. |

Flags: `--requests`, `--concurrency`, `--seats`, `--hot-seats`,
`--per-user-limit`, `--hold-seconds`, `--admin-token`.

`--concurrency` is a real in-flight ceiling over a keep-alive connection pool.
Firing 20,000 unbounded promises measures the client's file-descriptor limit,
not the server.

Verified against the **live Render instance**, 20,000 requests at 100 in
flight, 500 seats, 10 hot:

```
  409 seat_taken..............      17883
  409 per_user_limit..........       1583
  201 confirmed...............        370
  201 idempotent replay.......        162

  throughput (req/s)..........        106
  p50 / p95 / p99 (ms)........  895 / 2103 / 3484

  reconciliation: 130 + 0 + 370 = 500 (expected 500)

  [ PASS ] zero 5xx responses (saw 0)
  [ PASS ] no seat sold twice (500 seats contested)
  [ PASS ] available + held + confirmed == total_seats
  [ PASS ] occupied seats match distinct 201s
  [ PASS ] per-user limit of 4 held
  [ PASS ] each idempotency key -> one reservation (162 replays)
  RESULT: PASSED
```

The same burst against a local Docker container sustains **1,334 req/s at
p50 184ms / p99 912ms**. The gap is the free instance (0.1 CPU, 512 MB) and
the public network hop, not the design — the correctness results are
identical either way, which is the point.

---

## Swagger

Browsable API at **http://localhost:3000/docs** when running locally, with the
raw OpenAPI 3 document at `/docs-json`.

To exercise the secured endpoints from the browser:

1. `POST /auth/token` with `{"user_id": "alice"}` → copy the `token`
2. Click **Authorize** → paste it under the `bearer` scheme
3. For `POST /shows`, use the `x-admin-token` scheme with your `ADMIN_TOKEN`

Authorization persists across page reloads.

Swagger is **on outside production and off in production** — it is a
development convenience, not part of the deployed surface. Set
`SWAGGER_ENABLED=true` on the deployed instance to turn it on temporarily.

## API

Money is always an integer number of paise. Identity always comes from the JWT
subject; a `user_id` in the request body is stripped and ignored.

### `POST /auth/token` — dev identity shim

```bash
curl -X POST $URL/auth/token -H 'content-type: application/json' \
  -d '{"user_id":"alice"}'
# -> { "user_id": "alice", "role": "user", "token": "eyJ...", "expires_in": "24h" }
```

`POST /auth/tokens/bulk {"count": 5000}` mints many at once, so a load generator
doesn't spend 20,000 round trips before the burst starts. There is no user
table and no password: what is real here is that identity is *derived from a
signed token* and cannot be asserted by the body.

### `POST /shows` — admin

```bash
curl -X POST $URL/shows -H 'content-type: application/json' \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"name":"friday-night","seats":["A1","A2","A12"],"price_paise":25000,"per_user_limit":4}'
```

Returns the show with every seat `available`. `per_user_limit` defaults to 4.
An admin JWT (`role: "admin"`) works too.

### `POST /shows/{id}/reserve` — authenticated

```bash
curl -X POST $URL/shows/$SHOW_ID/reserve \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: 7f3c…' \
  -d '{"seats":["A12"]}'
```

```json
{
  "reservation_id": "…", "show_id": "…", "user_id": "alice",
  "seats": ["A12"], "amount_paise": 25000, "status": "confirmed",
  "expires_at": null, "created_at": "2026-10-01T12:52:34.670Z"
}
```

- The idempotency key may be the `Idempotency-Key` header or an
  `idempotency_key` body field. The header wins.
- Add `"hold_seconds": 120` to create a time-boxed **hold** instead of an
  immediate confirmation. Omit it and the seats are confirmed outright.
- **All-or-nothing**: if any requested seat is unavailable, nothing is reserved
  and the response names the seats that blocked it.

| Outcome | Status | `error.code` |
|---|---|---|
| Reserved | 201 | — |
| Retry of the same key and body | 201, `idempotent_replay: true` | — |
| Seat already held or confirmed | 409 | `seat_taken` |
| Would exceed the per-user limit | 409 | `per_user_limit` |
| Same key, different body | 409 | `idempotency_key_reuse` |
| Same key still being processed | 409 | `request_in_flight` |
| Unknown show or seat | 404 | `show_not_found`, `seat_not_found` |
| Malformed request | 422 | `validation_failed` |
| Pool saturated | 429 | `service_busy` |
| Database unreachable | 503 | `dependency_unavailable` |

### `POST /reservations/{id}/confirm` · `POST /reservations/{id}/cancel` · `GET /reservations/{id}`

Owner only. A non-owner gets 404, not 403 — a stranger must not be able to
probe which reservation ids exist. Cancellation is idempotent.

### `GET /shows/{id}` — state and reconciliation

```json
{
  "id": "…", "name": "friday-night", "price_paise": 25000,
  "per_user_limit": 4, "total_seats": 500,
  "counts": { "available": 128, "held": 0, "confirmed": 372, "total": 500 },
  "reconciled": true,
  "seats": [{ "seat_number": "A1", "status": "available", "held_until": null }]
}
```

`reconciled` is asserted on every call, not merely documented: if the three
buckets ever fail to sum to `total_seats` it logs an error and reports `false`.

### Health and metrics

| Endpoint | Behaviour |
|---|---|
| `GET /healthz`, `/health/live` | Liveness. Never touches the database — a DB blip must not get a healthy process killed. |
| `GET /readyz`, `/health/ready` | Readiness. Runs a real query with a 1s timeout and **fails closed with 503**. |
| `GET /metrics` | Prometheus. |

Key series:

```
reservations_confirmed_total
reservations_declined_total{reason="seat_taken|per_user_limit|idempotent_replay|…"}
seats_available{show_id,show_name}      seats_held{…}      seats_confirmed{…}
seats_reconciliation_ok{…}              # 0 means the invariant broke
http_server_errors_total{route}         # must stay flat during a burst
reservation_tx_retries_total{sqlstate}
reservation_duration_seconds{outcome}   db_pool_waiting_requests
```

The seat gauges are computed from the database **at scrape time**, with a 1s
cache. They therefore reconcile with `GET /shows/{id}` by construction, because
both read the same rows — a counter you remember to decrement is a counter that
eventually drifts.

### Logs

Structured JSON (pino) on stdout. Every line carries `request_id`, taken from
an inbound `X-Request-Id` when present and echoed back on the response, and
propagated through `AsyncLocalStorage` so no call site has to thread it.
Successful requests are sampled 1-in-`LOG_SAMPLE_RATE`; **every** non-2xx is
logged in full, because declines are the interesting part of a burst.

```json
{"level":"info","time":"…","request_id":"…","user_id":"alice","show_id":"…",
 "seats":["A12"],"outcome":"declined","reason":"seat_taken","msg":"reservation declined"}
```

```bash
docker compose logs -f api        # local
# Render: Dashboard -> service -> Logs (live tail)
```

---

## Configuration

Everything has a working default; see `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `…localhost:5433/seats` | |
| `DB_POOL_MAX` | `15` | Keep well under the server's `max_connections`. |
| `DB_STATEMENT_TIMEOUT_MS` | `3000` | A reservation is a handful of indexed statements. |
| `JWT_SECRET` / `ADMIN_TOKEN` | dev values | Generated on Render. |
| `DEFAULT_PER_USER_LIMIT` | `4` | |
| `DEFAULT_HOLD_SECONDS` / `MAX_HOLD_SECONDS` | `120` / `900` | |
| `IDEMPOTENCY_WAIT_MS` | `2000` | A duplicate waits this long for the original. Must exceed p99. |
| `TX_MAX_RETRIES` | `3` | Retries on `40001` / `40P01` / `55P03` only. |
| `EXPIRY_SWEEP_INTERVAL_MS` | `5000` | |
| `LOG_SAMPLE_RATE` | `20` | 1-in-N successes; all errors always logged. |
| `SWAGGER_ENABLED` | on, except in production | Serves Swagger UI at `/docs`. |

## Deploy

`render.yaml` is a Render blueprint (Docker web service + free Postgres).
Point Render at the repo, apply the blueprint, done — `JWT_SECRET` and
`ADMIN_TOKEN` are generated, `DATABASE_URL` is wired from the database, and the
health check path is `/readyz` so traffic is only routed once the database is
actually reachable. Free-tier instances spin down when idle; the burst script
waits up to 120s for readiness so a cold start is reported as a cold start
rather than as a failure.

---

See **[WRITEUP.md](WRITEUP.md)** for the atomicity mechanism, the idempotency
protocol, the CAP position, and the AI-usage disclosure.
