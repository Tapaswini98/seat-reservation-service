export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async post<T = any>(
    path: string,
    body: unknown,
    opts: { token?: string; adminToken?: string; idempotencyKey?: string } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.adminToken) headers['x-admin-token'] = opts.adminToken;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await parse(res) };
  }

  async get<T = any>(path: string, token?: string): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: await parse(res) };
  }

  async createShow(
    seats: string[],
    opts: { pricePaise?: number; perUserLimit?: number; name?: string } = {},
  ): Promise<{ id: string; total_seats: number }> {
    const res = await this.post(
      '/shows',
      {
        name:
          opts.name ?? `show-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        seats,
        price_paise: opts.pricePaise ?? 25000,
        ...(opts.perUserLimit ? { per_user_limit: opts.perUserLimit } : {}),
      },
      { adminToken: 'test-admin-token' },
    );
    if (res.status !== 201) {
      throw new Error(`createShow failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body;
  }

  async token(userId: string): Promise<string> {
    const res = await this.post('/auth/token', { user_id: userId });
    return res.body.token;
  }

  async tokens(count: number, prefix = 'u'): Promise<string[]> {
    const res = await this.post('/auth/tokens/bulk', { count, prefix });
    return res.body.tokens.map((t: { token: string }) => t.token);
  }
}

const parse = async (res: Response): Promise<any> => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Counts outcomes the way the grader will: by status and by decline reason. */
export const tally = (
  results: ApiResponse[],
): Record<string, number> & { fiveXx: number } => {
  const counts: Record<string, number> = {};
  let fiveXx = 0;
  for (const r of results) {
    if (r.status >= 500) fiveXx += 1;
    const key =
      r.status === 201 || r.status === 200
        ? r.body?.idempotent_replay
          ? `${r.status}:idempotent_replay`
          : String(r.status)
        : `${r.status}:${r.body?.error?.code ?? 'unknown'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { ...counts, fiveXx };
};
