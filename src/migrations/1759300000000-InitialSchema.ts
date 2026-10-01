import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1759300000000 implements MigrationInterface {
  name = 'InitialSchema1759300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "seat_status" AS ENUM ('available', 'held', 'confirmed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "reservation_status" AS ENUM ('held', 'confirmed', 'cancelled', 'expired');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await q.query(`
      DO $$ BEGIN
        CREATE TYPE "idempotency_status" AS ENUM ('in_progress', 'completed', 'declined');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "shows" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"            text NOT NULL UNIQUE,
        "price_paise"     bigint NOT NULL CHECK ("price_paise" >= 0),
        "per_user_limit"  integer NOT NULL DEFAULT 4 CHECK ("per_user_limit" > 0),
        "total_seats"     integer NOT NULL CHECK ("total_seats" > 0),
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "reservations" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "show_id"       uuid NOT NULL REFERENCES "shows"("id") ON DELETE CASCADE,
        "user_id"       text NOT NULL,
        "status"        reservation_status NOT NULL,
        "seat_count"    integer NOT NULL CHECK ("seat_count" > 0),
        "amount_paise"  bigint NOT NULL CHECK ("amount_paise" >= 0),
        "expires_at"    timestamptz NULL,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "seats" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "show_id"         uuid NOT NULL REFERENCES "shows"("id") ON DELETE CASCADE,
        "seat_number"     text NOT NULL,
        "status"          seat_status NOT NULL DEFAULT 'available',
        "reservation_id"  uuid NULL REFERENCES "reservations"("id"),
        "owner_user_id"   text NULL,
        "held_until"      timestamptz NULL,
        "version"         integer NOT NULL DEFAULT 0,
        CONSTRAINT "uq_seats_show_seat_number" UNIQUE ("show_id", "seat_number"),
        -- An occupied seat always names its owner and reservation; an available
        -- seat never does. Makes a half-written release impossible to commit.
        CONSTRAINT "ck_seats_occupancy_coherent" CHECK (
          ("status" = 'available' AND "reservation_id" IS NULL AND "owner_user_id" IS NULL AND "held_until" IS NULL)
          OR ("status" = 'held' AND "reservation_id" IS NOT NULL AND "owner_user_id" IS NOT NULL AND "held_until" IS NOT NULL)
          OR ("status" = 'confirmed' AND "reservation_id" IS NOT NULL AND "owner_user_id" IS NOT NULL AND "held_until" IS NULL)
        )
      )
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "reservation_seats" (
        "reservation_id" uuid NOT NULL REFERENCES "reservations"("id") ON DELETE CASCADE,
        "seat_id"        uuid NOT NULL REFERENCES "seats"("id") ON DELETE CASCADE,
        "seat_number"    text NOT NULL,
        PRIMARY KEY ("reservation_id", "seat_id")
      )
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "idempotency_keys" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"          text NOT NULL,
        "idempotency_key"  text NOT NULL,
        "request_hash"     text NOT NULL,
        "status"           idempotency_status NOT NULL,
        "http_status"      integer NULL,
        "response"         jsonb NULL,
        "reservation_id"   uuid NULL,
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "expires_at"       timestamptz NOT NULL,
        CONSTRAINT "uq_idempotency_user_key" UNIQUE ("user_id", "idempotency_key")
      )
    `);

    // Per-user quota count for a show: one index-only scan.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "ix_seats_show_owner_active"
        ON "seats" ("show_id", "owner_user_id")
        WHERE "status" <> 'available'
    `);
    // Expiry sweeper: only ever scans live holds.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "ix_seats_held_until"
        ON "seats" ("held_until")
        WHERE "status" = 'held'
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "ix_seats_show_status" ON "seats" ("show_id", "status")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "ix_seats_reservation" ON "seats" ("reservation_id")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "ix_reservations_show_user" ON "reservations" ("show_id", "user_id")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "ix_reservations_expiry"
        ON "reservations" ("expires_at") WHERE "status" = 'held'
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "ix_idempotency_expires_at" ON "idempotency_keys" ("expires_at")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "idempotency_keys"`);
    await q.query(`DROP TABLE IF EXISTS "reservation_seats"`);
    await q.query(`DROP TABLE IF EXISTS "seats"`);
    await q.query(`DROP TABLE IF EXISTS "reservations"`);
    await q.query(`DROP TABLE IF EXISTS "shows"`);
    await q.query(`DROP TYPE IF EXISTS "idempotency_status"`);
    await q.query(`DROP TYPE IF EXISTS "reservation_status"`);
    await q.query(`DROP TYPE IF EXISTS "seat_status"`);
  }
}
