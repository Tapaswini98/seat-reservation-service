import { DataSource } from 'typeorm';
import { ApiClient } from './helpers/client';
import { TestApp, resetDatabase, startTestApp } from './helpers/app';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('holds, cancellation and identity', () => {
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

  it('confirms immediately when no hold is requested', async () => {
    const show = await api.createShow(['A1'], { pricePaise: 25000 });
    const token = await api.token('buyer');

    const res = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['A1'] },
      { token },
    );
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.expires_at).toBeNull();
    expect(res.body.amount_paise).toBe(25000);
  });

  it('prices a multi-seat reservation in integer paise', async () => {
    const show = await api.createShow(['A1', 'A2', 'A3'], { pricePaise: 33333 });
    const token = await api.token('buyer');

    const res = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['A1', 'A2', 'A3'] },
      { token },
    );
    expect(res.body.amount_paise).toBe(99999);
    expect(Number.isInteger(res.body.amount_paise)).toBe(true);
  });

  it('expires a hold and makes the seat cleanly re-bookable', async () => {
    const show = await api.createShow(['H1']);
    const first = await api.token('holder');
    const second = await api.token('next-buyer');

    const held = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['H1'], hold_seconds: 1 },
      { token: first },
    );
    expect(held.status).toBe(201);
    expect(held.body.status).toBe('held');

    const blocked = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['H1'] },
      { token: second },
    );
    expect(blocked.status).toBe(409);

    await sleep(2500);

    const state = await api.get(`/shows/${show.id}`);
    expect(state.body.counts).toMatchObject({ available: 1, held: 0, confirmed: 0 });

    const rebooked = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['H1'] },
      { token: second },
    );
    expect(rebooked.status).toBe(201);

    // And the expired hold cannot be revived.
    const confirmLate = await api.post(
      `/reservations/${held.body.reservation_id}/confirm`,
      {},
      { token: first },
    );
    expect(confirmLate.status).toBe(409);
    expect(['reservation_expired', 'reservation_not_held']).toContain(
      confirmLate.body.error.code,
    );
  });

  it('promotes a hold to confirmed', async () => {
    const show = await api.createShow(['K1', 'K2']);
    const token = await api.token('holder');

    const held = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['K1'], hold_seconds: 60 },
      { token },
    );
    const confirmed = await api.post(
      `/reservations/${held.body.reservation_id}/confirm`,
      {},
      { token },
    );

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');
    expect(confirmed.body.expires_at).toBeNull();

    const state = await api.get(`/shows/${show.id}`);
    expect(state.body.counts).toMatchObject({ available: 1, held: 0, confirmed: 1 });
  });

  it('frees quota when a reservation is cancelled', async () => {
    const show = await api.createShow(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'], {
      perUserLimit: 2,
    });
    const token = await api.token('quota-user');

    const first = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['Q1', 'Q2'] },
      { token },
    );
    expect(first.status).toBe(201);

    expect(
      (await api.post(`/shows/${show.id}/reserve`, { seats: ['Q3'] }, { token }))
        .status,
    ).toBe(409);

    await api.post(`/reservations/${first.body.reservation_id}/cancel`, {}, { token });

    expect(
      (await api.post(`/shows/${show.id}/reserve`, { seats: ['Q3'] }, { token }))
        .status,
    ).toBe(201);
  });

  it('lets only the owner cancel, and hides others reservations', async () => {
    const show = await api.createShow(['O1']);
    const owner = await api.token('owner');
    const stranger = await api.token('stranger');

    const reserved = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['O1'] },
      { token: owner },
    );
    const id = reserved.body.reservation_id;

    const strangerCancel = await api.post(
      `/reservations/${id}/cancel`,
      {},
      {
        token: stranger,
      },
    );
    expect(strangerCancel.status).toBe(404);

    const strangerRead = await api.get(`/reservations/${id}`, stranger);
    expect(strangerRead.status).toBe(404);

    // The seat is untouched by the failed attempt.
    const state = await api.get(`/shows/${show.id}`);
    expect(state.body.counts.confirmed).toBe(1);

    const ownerCancel = await api.post(
      `/reservations/${id}/cancel`,
      {},
      { token: owner },
    );
    expect(ownerCancel.status).toBe(200);
  });

  it('never resurrects a seat already confirmed to someone else', async () => {
    const show = await api.createShow(['R1']);
    const first = await api.token('first');
    const second = await api.token('second');

    const held = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['R1'], hold_seconds: 1 },
      { token: first },
    );
    await sleep(2500);

    const resold = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['R1'] },
      { token: second },
    );
    expect(resold.status).toBe(201);

    // A late cancel of the expired hold must not free the seat out from under
    // its new owner.
    await api.post(
      `/reservations/${held.body.reservation_id}/cancel`,
      {},
      {
        token: first,
      },
    );

    const owners = await ds.query(
      `SELECT owner_user_id, status::text AS status FROM seats
       WHERE show_id = $1 AND seat_number = 'R1'`,
      [show.id],
    );
    expect(owners[0].status).toBe('confirmed');
    expect(owners[0].owner_user_id).toBe('second');
  });

  it('derives identity from the token and ignores a spoofed body field', async () => {
    const show = await api.createShow(['S1']);
    const attacker = await api.token('attacker');

    const res = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['S1'], user_id: 'victim' },
      { token: attacker },
    );

    expect(res.status).toBe(201);
    expect(res.body.user_id).toBe('attacker');

    const rows = await ds.query(
      `SELECT owner_user_id FROM seats WHERE show_id = $1 AND seat_number = 'S1'`,
      [show.id],
    );
    expect(rows[0].owner_user_id).toBe('attacker');
  });

  it('rejects unauthenticated and non-admin access', async () => {
    const unauth = await api.post(
      '/shows/00000000-0000-4000-8000-000000000000/reserve',
      {
        seats: ['A1'],
      },
    );
    expect(unauth.status).toBe(401);

    const userToken = await api.token('plain-user');
    const forbidden = await api.post(
      '/shows',
      { name: 'nope', seats: ['A1'], price_paise: 100 },
      { token: userToken },
    );
    expect(forbidden.status).toBe(403);
  });

  it('cancellation is idempotent', async () => {
    const show = await api.createShow(['I1']);
    const token = await api.token('owner');
    const reserved = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['I1'] },
      { token },
    );
    const id = reserved.body.reservation_id;

    const first = await api.post(`/reservations/${id}/cancel`, {}, { token });
    const second = await api.post(`/reservations/${id}/cancel`, {}, { token });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('cancelled');
  });
});
