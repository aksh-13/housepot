import pg from "pg";

// Dates without a time (settlement_date, anchor_date) stay as "YYYY-MM-DD" strings.
pg.types.setTypeParser(1082, (v) => v);

export type Db = {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** Runs fn inside one transaction. Called on a Db that is already in a transaction, it joins it. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
};

type Queryable = { query: (sql: string, params?: any[]) => Promise<pg.QueryResult<any>> };

async function run<T>(q: Queryable, sql: string, params?: unknown[]) {
  const r = await q.query(sql, params as any[]);
  return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
}

function clientDb(client: pg.PoolClient): Db {
  const self: Db = {
    query: (sql, params) => run(client, sql, params),
    tx: (fn) => fn(self),
  };
  return self;
}

function poolDb(pool: pg.Pool): Db {
  return {
    query: (sql, params) => run(pool, sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(clientDb(client));
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

const globalForDb = globalThis as unknown as { __housepotDb?: Db };

/** One shared connection pool per process, built from DATABASE_URL. */
export function getDb(): Db {
  if (!globalForDb.__housepotDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForDb.__housepotDb = poolDb(new pg.Pool({ connectionString, max: 10 }));
  }
  return globalForDb.__housepotDb;
}
