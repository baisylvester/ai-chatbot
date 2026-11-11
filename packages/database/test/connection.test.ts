import { afterEach, describe, expect, it } from "vitest";
import { connectionConfig } from "../src/client.ts";
import { SUPABASE_ROOT_CA } from "../src/supabase-ca.ts";

describe("connectionConfig", () => {
  afterEach(() => {
    delete process.env.DATABASE_CA_CERT;
  });

  it("trusts the Supabase root CA for Supabase pooler hosts, with full verification", () => {
    const cfg = connectionConfig("postgresql://postgres.ref:pw@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require");
    expect(cfg.ssl).toEqual({ ca: SUPABASE_ROOT_CA, rejectUnauthorized: true });
    // sslmode would override the ssl object inside pg, so it must be gone from the URL.
    expect(cfg.connectionString).not.toContain("sslmode");
  });

  it("does the same for direct Supabase hosts", () => {
    const cfg = connectionConfig("postgresql://postgres:pw@db.ref.supabase.co:5432/postgres");
    expect(cfg.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it("keeps strict verify-full for other hosts", () => {
    const cfg = connectionConfig("postgresql://u:pw@ep-x.ap-southeast-1.aws.neon.tech/db?sslmode=require");
    expect(cfg.ssl).toBeUndefined();
    expect(cfg.connectionString).toContain("sslmode=verify-full");
  });

  it("respects sslmode=disable (local Postgres)", () => {
    const cfg = connectionConfig("postgresql://u:pw@db.ref.supabase.co:5432/postgres?sslmode=disable");
    expect(cfg.ssl).toBeUndefined();
  });

  it("uses DATABASE_CA_CERT when set", () => {
    process.env.DATABASE_CA_CERT = "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----";
    const cfg = connectionConfig("postgresql://u:pw@db.internal.example:5432/app");
    expect(cfg.ssl).toMatchObject({ ca: process.env.DATABASE_CA_CERT });
  });
});
