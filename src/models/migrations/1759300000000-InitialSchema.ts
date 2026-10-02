import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1759300000000 implements MigrationInterface {
  name = 'InitialSchema1759300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "seat_status" AS ENUM ('available', 'held', 'confirmed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "reservation_status" AS ENUM ('held', 'confirmed', 'cancelled', 'expired');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "idempotency_status" AS ENUM ('in_progress', 'completed', 'declined');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shows" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"            text NOT NULL UNIQUE,
        "price_paise"     bigint NOT NULL CHECK ("price_paise" >= 0),
        "per_user_limit"  integer NOT NULL DEFAULT 4 CHECK ("per_user_limit" > 0),
        "total_seats"     integer NOT NULL CHECK ("total_seats" > 0),
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
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

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "seats" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "show_id"         uuid NOT NULL REFERENCES "shows"("id") ON DELETE CASCADE,
        "seat_number"     text NOT NULL,
        "status"          seat_status NOT NULL DEFAULT 'available',
        "reservation_id"  uuid NULL REFERENCES "reservations"("id"),
        "owner_user_id"   text NULL,
        "held_until"      timestamptz NULL,
        "version"         integer NOT NULL DEFAULT 0,
        CONSTRAINT "UQ_SEATS_SHOW_SEAT_NUMBER" UNIQUE ("show_id", "seat_number"),
        -- An occupied seat always names its owner and reservation; an available
        -- seat never does; only a held seat has an expiry. Makes a half-written
        -- allocation or a half-written release impossible to commit, which is
        -- the database-level backstop for the application's atomicity.
        CONSTRAINT "CHK_SEATS_OCCUPANCY_COHERENT" CHECK (
          ("status" = 'available' AND "reservation_id" IS NULL AND "owner_user_id" IS NULL AND "held_until" IS NULL)
          OR ("status" = 'held' AND "reservation_id" IS NOT NULL AND "owner_user_id" IS NOT NULL AND "held_until" IS NOT NULL)
          OR ("status" = 'confirmed' AND "reservation_id" IS NOT NULL AND "owner_user_id" IS NOT NULL AND "held_until" IS NULL)
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reservation_seats" (
        "reservation_id" uuid NOT NULL REFERENCES "reservations"("id") ON DELETE CASCADE,
        "seat_id"        uuid NOT NULL REFERENCES "seats"("id") ON DELETE CASCADE,
        "seat_number"    text NOT NULL,
        PRIMARY KEY ("reservation_id", "seat_id")
      )
    `);

    await queryRunner.query(`
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
        CONSTRAINT "UQ_IDEMPOTENCY_USER_KEY" UNIQUE ("user_id", "idempotency_key")
      )
    `);

    // Per-user quota count for a show: one index-only scan on the hot path.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SEATS_SHOW_OWNER_ACTIVE"
        ON "seats" ("show_id", "owner_user_id")
        WHERE "status" <> 'available'
    `);
    // Expiry sweeper: only ever scans live holds.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SEATS_HELD_UNTIL"
        ON "seats" ("held_until")
        WHERE "status" = 'held'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SEATS_SHOW_STATUS" ON "seats" ("show_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SEATS_RESERVATION" ON "seats" ("reservation_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_RESERVATIONS_SHOW_USER"
        ON "reservations" ("show_id", "user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_RESERVATIONS_EXPIRES_AT"
        ON "reservations" ("expires_at") WHERE "status" = 'held'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_IDEMPOTENCY_EXPIRES_AT"
        ON "idempotency_keys" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "idempotency_keys"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reservation_seats"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "seats"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reservations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shows"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "idempotency_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "reservation_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "seat_status"`);
  }
}
