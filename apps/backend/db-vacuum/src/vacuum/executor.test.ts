import { describe, expect, it } from "vitest";
import {
  buildVacuumStatement,
  InvalidIdentifierError,
  isVacuumInProgress,
  PgVacuumExecutor,
  quoteIdentifier,
  quoteQualifiedName,
  RecordingVacuumExecutor,
  type VacuumClient,
} from "./executor.js";

class FakeClient implements VacuumClient {
  readonly statements: string[] = [];
  released = false;
  failOn: (text: string) => string | null = () => null;

  async query(text: string, _values?: unknown[]): Promise<{ rows: any[] }> {
    this.statements.push(text);
    const failure = this.failOn(text);
    if (failure) throw new Error(failure);
    if (text.includes("pg_stat_activity")) return { rows: [{ running: true }] };
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

function makePool(client: FakeClient) {
  return { connect: async () => client };
}

describe("quoteIdentifier", () => {
  it("quotes valid identifiers", () => {
    expect(quoteIdentifier("orders")).toBe('"orders"');
    expect(quoteIdentifier("Order_Items$2")).toBe('"Order_Items$2"');
  });

  it("rejects anything that is not a bare identifier", () => {
    for (const bad of [
      'orders"; DROP TABLE users; --',
      "public.orders",
      "orders;",
      "1orders",
      "",
      "order items",
      'or"ders',
    ]) {
      expect(() => quoteIdentifier(bad), bad).toThrow(InvalidIdentifierError);
    }
  });
});

describe("quoteQualifiedName", () => {
  it("quotes both parts", () => {
    expect(quoteQualifiedName("public", "orders")).toBe('"public"."orders"');
  });

  it("refuses reserved schemas", () => {
    for (const schema of ["pg_catalog", "information_schema", "pg_toast", "pg_temp_1"]) {
      expect(() => quoteQualifiedName(schema, "t"), schema).toThrow(InvalidIdentifierError);
    }
  });
});

describe("buildVacuumStatement", () => {
  const target = { schema: "public", table: "orders" };

  it("issues a non-blocking VACUUM ANALYZE by default", () => {
    const sql = buildVacuumStatement(target);
    expect(sql).toBe('VACUUM (ANALYZE) "public"."orders";');
    // VACUUM FULL takes an ACCESS EXCLUSIVE lock — it must never appear.
    expect(sql).not.toMatch(/FULL/i);
  });

  it("can omit ANALYZE", () => {
    expect(buildVacuumStatement(target, { analyze: false })).toBe('VACUUM "public"."orders";');
  });

  it("adds VERBOSE when requested", () => {
    expect(buildVacuumStatement(target, { verbose: true })).toBe(
      'VACUUM (ANALYZE, VERBOSE) "public"."orders";',
    );
  });

  it("rejects a target whose identifiers could inject SQL", () => {
    expect(() =>
      buildVacuumStatement({ schema: "public", table: 'orders"; DELETE FROM users; --' }),
    ).toThrow(InvalidIdentifierError);
  });
});

describe("PgVacuumExecutor", () => {
  it("sets a statement timeout, vacuums in autocommit, then resets and releases", async () => {
    const client = new FakeClient();
    const executor = new PgVacuumExecutor(makePool(client), 30_000);

    const result = await executor.vacuum({ schema: "public", table: "orders" });

    expect(client.statements).toEqual([
      "SET statement_timeout = 30000",
      'VACUUM (ANALYZE) "public"."orders";',
      "RESET statement_timeout",
    ]);
    expect(client.released).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.qualifiedName).toBe("public.orders");
  });

  it("never wraps the VACUUM in a transaction block", async () => {
    const client = new FakeClient();
    await new PgVacuumExecutor(makePool(client)).vacuum({ schema: "public", table: "orders" });
    // PostgreSQL rejects VACUUM inside a transaction block, so BEGIN/COMMIT
    // must never appear alongside it.
    expect(client.statements.join("\n")).not.toMatch(/BEGIN|COMMIT|START TRANSACTION/i);
  });

  it("releases the connection and resets the timeout when the vacuum fails", async () => {
    const client = new FakeClient();
    client.failOn = (text) => (text.startsWith("VACUUM") ? "could not obtain lock" : null);
    const executor = new PgVacuumExecutor(makePool(client));

    await expect(
      executor.vacuum({ schema: "public", table: "orders" }),
    ).rejects.toThrow("could not obtain lock");
    expect(client.released).toBe(true);
    expect(client.statements).toContain("RESET statement_timeout");
  });

  it("does not check out a connection for a dry run", async () => {
    let connects = 0;
    const executor = new PgVacuumExecutor({
      connect: async () => {
        connects += 1;
        return new FakeClient();
      },
    });

    const result = await executor.vacuum(
      { schema: "public", table: "orders" },
      { dryRun: true },
    );

    expect(connects).toBe(0);
    expect(result.executed).toBe(false);
    expect(result.skipped).toBe("dry run");
  });

  it("validates identifiers before touching the pool", async () => {
    let connects = 0;
    const executor = new PgVacuumExecutor({
      connect: async () => {
        connects += 1;
        return new FakeClient();
      },
    });

    await expect(
      executor.vacuum({ schema: "public", table: "bad name" }),
    ).rejects.toThrow(InvalidIdentifierError);
    expect(connects).toBe(0);
  });

  it("reports a vacuum already in progress for a table", async () => {
    const client = new FakeClient();
    const executor = new PgVacuumExecutor(makePool(client));
    expect(await executor.isVacuumInProgress({ schema: "public", table: "orders" })).toBe(true);
    expect(client.statements[0]).toContain("pg_stat_activity");
    expect(client.released).toBe(true);
  });

  it("honours a per-call statement timeout override", async () => {
    const client = new FakeClient();
    await new PgVacuumExecutor(makePool(client)).vacuum(
      { schema: "public", table: "orders" },
      { statementTimeoutMs: 1500 },
    );
    expect(client.statements[0]).toBe("SET statement_timeout = 1500");
  });
});

describe("isVacuumInProgress", () => {
  it("binds the qualified name as a parameter", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return { rows: [{ running: false }] };
      },
    };

    const running = await isVacuumInProgress(db, { schema: "public", table: "orders" });
    expect(running).toBe(false);
    expect(calls[0]?.values).toEqual(['"public"."orders"']);
  });
});

describe("RecordingVacuumExecutor", () => {
  it("records calls without a database", async () => {
    const executor = new RecordingVacuumExecutor();
    const result = await executor.vacuum({ schema: "public", table: "orders" });

    expect(executor.calls).toHaveLength(1);
    expect(result.executed).toBe(true);
    expect(result.statement).toBe('VACUUM (ANALYZE) "public"."orders";');
  });

  it("fails once per configured error", async () => {
    const executor = new RecordingVacuumExecutor();
    executor.failNext("public.orders", "permission denied");

    await expect(
      executor.vacuum({ schema: "public", table: "orders" }),
    ).rejects.toThrow("permission denied");
    await expect(
      executor.vacuum({ schema: "public", table: "orders" }),
    ).resolves.toMatchObject({ executed: true });
  });

  it("tracks which tables are already being vacuumed", async () => {
    const executor = new RecordingVacuumExecutor();
    const target = { schema: "public", table: "orders" };

    expect(await executor.isVacuumInProgress(target)).toBe(false);
    executor.setVacuumInProgress("public.orders");
    expect(await executor.isVacuumInProgress(target)).toBe(true);
    executor.setVacuumInProgress("public.orders", false);
    expect(await executor.isVacuumInProgress(target)).toBe(false);
  });

  it("does not execute a dry run but still records the attempt", async () => {
    const executor = new RecordingVacuumExecutor();
    const result = await executor.vacuum(
      { schema: "public", table: "orders" },
      { dryRun: true },
    );
    expect(result.executed).toBe(false);
    expect(executor.calls).toHaveLength(1);
  });
});
