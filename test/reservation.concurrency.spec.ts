import { DataSource } from 'typeorm';
import { ApiClient, ApiResponse, tally } from './helpers/client';
import { TestApp, resetDatabase, startTestApp } from './helpers/app';

describe('reservation correctness under contention', () => {
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

  const assertReconciled = async (showId: string, total: number) => {
    const state = await api.get(`/shows/${showId}`);
    const { available, held, confirmed } = state.body.counts;
    expect(available + held + confirmed).toBe(total);
    expect(state.body.reconciled).toBe(true);
    return state.body;
  };

  it('a 500-way storm on one seat produces exactly one winner and no 5xx', async () => {
    const show = await api.createShow(['A12', 'A13', 'A14']);
    const tokens = await api.tokens(500, 'storm');

    const results = await Promise.all(
      tokens.map((token) =>
        api.post(`/shows/${show.id}/reserve`, { seats: ['A12'] }, { token }),
      ),
    );

    const counts = tally(results);
    expect(counts.fiveXx).toBe(0);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(counts['409:seat_taken']).toBe(499);

    const state = await assertReconciled(show.id, 3);
    expect(state.counts.confirmed).toBe(1);

    // And at the storage layer: exactly one row owns A12.
    const owners = await ds.query(
      `SELECT owner_user_id FROM seats WHERE show_id = $1 AND seat_number = 'A12'`,
      [show.id],
    );
    expect(owners).toHaveLength(1);
    expect(owners[0].owner_user_id).not.toBeNull();
  });

  it('a stampede across ten hot seats confirms at most ten', async () => {
    const hot = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10'];
    const show = await api.createShow([...hot, 'X1', 'X2', 'X3']);
    const tokens = await api.tokens(600, 'stampede');

    const results = await Promise.all(
      tokens.map((token, i) =>
        api.post(
          `/shows/${show.id}/reserve`,
          { seats: [hot[i % hot.length]] },
          { token },
        ),
      ),
    );

    const counts = tally(results);
    expect(counts.fiveXx).toBe(0);
    expect(results.filter((r) => r.status === 201)).toHaveLength(hot.length);

    const state = await assertReconciled(show.id, 13);
    expect(state.counts.confirmed).toBe(10);

    // No seat was handed to two people.
    const dupes = await ds.query(
      `SELECT rs.seat_number, count(*) FROM reservation_seats rs
       JOIN seats s ON s.id = rs.seat_id
       WHERE s.show_id = $1 GROUP BY rs.seat_number HAVING count(*) > 1`,
      [show.id],
    );
    expect(dupes).toHaveLength(0);
  });

  it('holds the per-user limit when one user fires ten parallel reserves', async () => {
    const seats = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    const show = await api.createShow(seats, { perUserLimit: 4 });
    const token = await api.token('greedy-user');

    const results = await Promise.all(
      seats.map((seat) =>
        api.post(`/shows/${show.id}/reserve`, { seats: [seat] }, { token }),
      ),
    );

    const counts = tally(results);
    expect(counts.fiveXx).toBe(0);
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    expect(counts['409:per_user_limit']).toBe(6);

    const state = await assertReconciled(show.id, 10);
    expect(state.counts.confirmed).toBe(4);
  });

  it('counts a multi-seat request against the limit as a whole', async () => {
    const show = await api.createShow(['M1', 'M2', 'M3', 'M4', 'M5', 'M6'], {
      perUserLimit: 4,
    });
    const token = await api.token('multi-user');

    const first = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['M1', 'M2', 'M3'] },
      { token },
    );
    expect(first.status).toBe(201);

    // 3 held + 2 requested > 4, so this is declined whole.
    const second = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['M4', 'M5'] },
      { token },
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('per_user_limit');

    const state = await assertReconciled(show.id, 6);
    expect(state.counts.confirmed).toBe(3);
  });

  it('is all-or-nothing: a partially available multi-seat request reserves nothing', async () => {
    const show = await api.createShow(['P1', 'P2', 'P3']);
    const owner = await api.token('owner');
    const other = await api.token('other');

    expect(
      (await api.post(`/shows/${show.id}/reserve`, { seats: ['P2'] }, { token: owner }))
        .status,
    ).toBe(201);

    const partial = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['P1', 'P2'] },
      { token: other },
    );
    expect(partial.status).toBe(409);
    expect(partial.body.error.code).toBe('seat_taken');
    expect(partial.body.error.details.unavailable_seats).toEqual(['P2']);

    // P1 must still be free -- nothing was half-taken.
    const state = await assertReconciled(show.id, 3);
    const p1 = state.seats.find((s: { seat_number: string }) => s.seat_number === 'P1');
    expect(p1.status).toBe('available');
  });

  it('does not deadlock when two users fight over the same pair in opposite order', async () => {
    const show = await api.createShow(['D1', 'D2'], { perUserLimit: 100 });
    const rounds = 60;
    const results: ApiResponse[] = [];

    for (let i = 0; i < rounds; i += 1) {
      const [a, b] = await Promise.all([api.token(`da-${i}`), api.token(`db-${i}`)]);
      const pair = await Promise.all([
        api.post(`/shows/${show.id}/reserve`, { seats: ['D1', 'D2'] }, { token: a }),
        api.post(`/shows/${show.id}/reserve`, { seats: ['D2', 'D1'] }, { token: b }),
      ]);
      results.push(...pair);

      const winner = pair.find((r) => r.status === 201);
      expect(winner).toBeDefined();
      await api.post(
        `/reservations/${winner!.body.reservation_id}/cancel`,
        {},
        {
          token: pair.indexOf(winner!) === 0 ? a : b,
        },
      );
    }

    expect(tally(results).fiveXx).toBe(0);
    await assertReconciled(show.id, 2);
  });

  it('keeps reserve and cancel from double-allocating the same seat', async () => {
    const show = await api.createShow(['C1'], { perUserLimit: 10 });
    const holder = await api.token('holder');
    const sniper = await api.token('sniper');

    for (let i = 0; i < 40; i += 1) {
      const held = await api.post(
        `/shows/${show.id}/reserve`,
        { seats: ['C1'] },
        { token: holder },
      );
      expect(held.status).toBe(201);

      const [cancelled, sniped] = await Promise.all([
        api.post(
          `/reservations/${held.body.reservation_id}/cancel`,
          {},
          { token: holder },
        ),
        api.post(`/shows/${show.id}/reserve`, { seats: ['C1'] }, { token: sniper }),
      ]);

      expect(cancelled.status).toBe(200);
      expect([201, 409]).toContain(sniped.status);

      const owners = await ds.query(
        `SELECT count(*)::int AS n FROM seats
         WHERE show_id = $1 AND seat_number = 'C1' AND status <> 'available'`,
        [show.id],
      );
      // Never more than one live owner, whichever way the race went.
      expect(owners[0].n).toBeLessThanOrEqual(1);

      if (sniped.status === 201) {
        await api.post(
          `/reservations/${sniped.body.reservation_id}/cancel`,
          {},
          {
            token: sniper,
          },
        );
      }
    }

    await assertReconciled(show.id, 1);
  });
});
