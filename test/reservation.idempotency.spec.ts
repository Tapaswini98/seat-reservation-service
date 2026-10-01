import { DataSource } from 'typeorm';
import { ApiClient, tally } from './helpers/client';
import { TestApp, resetDatabase, startTestApp } from './helpers/app';

describe('idempotency', () => {
  let app: TestApp;
  let api: ApiClient;
  let ds: DataSource;

  beforeAll(async () => {
    app = await startTestApp();
    api = new ApiClient(app.baseUrl);
    ds = app.dataSource;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('replays the original reservation for a sequential retry', async () => {
    const show = await api.createShow(['A1', 'A2']);
    const token = await api.token('retrier');

    const first = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['A1'] },
      { token, idempotencyKey: 'key-1' },
    );
    const second = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['A1'] },
      { token, idempotencyKey: 'key-1' },
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.reservation_id).toBe(first.body.reservation_id);
    expect(second.body.idempotent_replay).toBe(true);

    const reservations = await ds.query(`SELECT count(*)::int AS n FROM reservations`);
    expect(reservations[0].n).toBe(1);
  });

  it('creates exactly one reservation for 50 parallel uses of one key', async () => {
    const show = await api.createShow(['B1', 'B2', 'B3', 'B4']);
    const token = await api.token('parallel-retrier');

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        api.post(
          `/shows/${show.id}/reserve`,
          { seats: ['B1'] },
          { token, idempotencyKey: 'parallel-key' },
        ),
      ),
    );

    expect(tally(results).fiveXx).toBe(0);

    // Every response that is not a 409 must name the same reservation. In-flight
    // duplicates wait briefly for the original, so in practice they all replay.
    const ids = new Set(
      results.filter((r) => r.status === 201).map((r) => r.body.reservation_id),
    );
    expect(ids.size).toBe(1);

    const rows = await ds.query(`SELECT count(*)::int AS n FROM reservations`);
    expect(rows[0].n).toBe(1);

    const seats = await ds.query(
      `SELECT count(*)::int AS n FROM seats WHERE show_id = $1 AND status <> 'available'`,
      [show.id],
    );
    expect(seats[0].n).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const show = await api.createShow(['C1', 'C2']);
    const token = await api.token('switcher');

    const first = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['C1'] },
      { token, idempotencyKey: 'key-2' },
    );
    expect(first.status).toBe(201);

    const reused = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['C2'] },
      { token, idempotencyKey: 'key-2' },
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reuse');

    // The second request must not have taken C2 as a side effect.
    const state = await api.get(`/shows/${show.id}`);
    expect(state.body.counts.available).toBe(1);
    expect(state.body.counts.confirmed).toBe(1);
  });

  it('treats seat order and the body field as equivalent to the header', async () => {
    const show = await api.createShow(['D1', 'D2']);
    const token = await api.token('canonical');

    const first = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['D1', 'D2'] },
      { token, idempotencyKey: 'key-3' },
    );
    expect(first.status).toBe(201);

    // Reversed seat order is the same request, and the key may arrive in the body.
    const replay = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['D2', 'D1'], idempotency_key: 'key-3' },
      { token },
    );
    expect(replay.status).toBe(201);
    expect(replay.body.reservation_id).toBe(first.body.reservation_id);
  });

  it('replays a decline rather than letting a retry turn it into a win', async () => {
    const show = await api.createShow(['E1']);
    const first = await api.token('first-owner');
    const loser = await api.token('loser');

    expect(
      (await api.post(`/shows/${show.id}/reserve`, { seats: ['E1'] }, { token: first }))
        .status,
    ).toBe(201);

    const declined = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['E1'] },
      { token: loser, idempotencyKey: 'loser-key' },
    );
    expect(declined.status).toBe(409);

    // The seat is freed, but a retry of the SAME key must still see the stored
    // decline. Otherwise an at-least-once client could end up with a seat it
    // was already told it could not have, which is the subtle bug that makes
    // retried payments double-charge.
    const reservationId = (
      await ds.query(`SELECT id FROM reservations WHERE user_id = 'first-owner'`)
    )[0].id;
    await api.post(`/reservations/${reservationId}/cancel`, {}, { token: first });

    const retry = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['E1'] },
      { token: loser, idempotencyKey: 'loser-key' },
    );
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('seat_taken');

    // A fresh key for the same user does succeed -- the seat really is free.
    const fresh = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['E1'] },
      { token: loser, idempotencyKey: 'loser-key-2' },
    );
    expect(fresh.status).toBe(201);
  });

  it('scopes keys per user, so two users may reuse the same key string', async () => {
    const show = await api.createShow(['F1', 'F2']);
    const [a, b] = await Promise.all([api.token('user-a'), api.token('user-b')]);

    const first = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['F1'] },
      { token: a, idempotencyKey: 'shared-key' },
    );
    const second = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['F2'] },
      { token: b, idempotencyKey: 'shared-key' },
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.reservation_id).not.toBe(second.body.reservation_id);
  });

  it('does not store a key when the request never reaches the domain', async () => {
    const show = await api.createShow(['G1']);
    const token = await api.token('validator');

    const invalid = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: [] },
      { token, idempotencyKey: 'validation-key' },
    );
    expect(invalid.status).toBe(422);

    // Validation runs before idempotency, so the key stays usable.
    const valid = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['G1'] },
      { token, idempotencyKey: 'validation-key' },
    );
    expect(valid.status).toBe(201);
  });
});
