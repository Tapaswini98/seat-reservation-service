import { DataSource } from 'typeorm';
import { ApiClient } from './helpers/client';
import { TestApp, resetDatabase, startTestApp } from './helpers/app';

describe('health and metrics', () => {
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

  it('liveness does not depend on the database', async () => {
    const res = await api.get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('readiness reports the database check', async () => {
    const res = await api.get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.checks.database.status).toBe('up');
  });

  it('metrics reconcile with the API state', async () => {
    const show = await api.createShow(['A1', 'A2', 'A3', 'A4']);
    const token = await api.token('metrics-user');

    await api.post(`/shows/${show.id}/reserve`, { seats: ['A1'] }, { token });
    await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['A2'], hold_seconds: 60 },
      {
        token,
      },
    );
    const loser = await api.token('metrics-loser');
    await api.post(`/shows/${show.id}/reserve`, { seats: ['A1'] }, { token: loser });

    // The gauge query is cached for a second; wait it out so the scrape is fresh.
    await new Promise((r) => setTimeout(r, 1100));
    const metrics = await api.get('/metrics');
    expect(metrics.status).toBe(200);

    const text: string = metrics.body;
    const gauge = (name: string): number => {
      const line = text
        .split('\n')
        .find((l) => l.startsWith(`${name}{`) && l.includes(show.id));
      if (!line) throw new Error(`gauge ${name} not found for show ${show.id}`);
      return Number(line.slice(line.lastIndexOf(' ') + 1));
    };

    const state = await api.get(`/shows/${show.id}`);
    expect(gauge('seats_available')).toBe(state.body.counts.available);
    expect(gauge('seats_held')).toBe(state.body.counts.held);
    expect(gauge('seats_confirmed')).toBe(state.body.counts.confirmed);
    expect(gauge('seats_reconciliation_ok')).toBe(1);

    expect(text).toContain('reservations_confirmed_total');
    expect(text).toMatch(/reservations_declined_total\{reason="seat_taken"\}\s+1/);
    expect(text).toContain('http_requests_total');
  });

  it('echoes a supplied correlation id back on the response', async () => {
    const res = await fetch(`${app.baseUrl}/healthz`, {
      headers: { 'x-request-id': 'trace-me-123' },
    });
    expect(res.headers.get('x-request-id')).toBe('trace-me-123');
  });

  it('declines are 4xx and carry a machine-readable code', async () => {
    const show = await api.createShow(['A1']);
    const a = await api.token('a');
    const b = await api.token('b');
    await api.post(`/shows/${show.id}/reserve`, { seats: ['A1'] }, { token: a });
    const declined = await api.post(
      `/shows/${show.id}/reserve`,
      { seats: ['A1'] },
      { token: b },
    );

    expect(declined.status).toBe(409);
    expect(declined.body.error.code).toBe('seat_taken');
    expect(declined.body.request_id).toBeTruthy();
  });

  it('an unknown show is a 404, not a 500', async () => {
    const token = await api.token('x');
    expect(
      (
        await api.post(
          '/shows/11111111-1111-4111-8111-111111111111/reserve',
          { seats: ['A1'] },
          { token },
        )
      ).status,
    ).toBe(404);

    // A malformed id must not reach Postgres and blow up as an invalid uuid.
    expect(
      (await api.post('/shows/not-a-uuid/reserve', { seats: ['A1'] }, { token }))
        .status,
    ).toBe(404);
  });
});
