BASE_URL ?= http://localhost:3000
REQUESTS ?= 20000
CONCURRENCY ?= 200

.PHONY: help up down logs migrate dev build test test-db burst burst-hot burst-limit burst-idem clean

help:
	@echo "make up        - start postgres + api in docker"
	@echo "make dev       - run the api locally against docker postgres"
	@echo "make test      - run the integration suite against a disposable postgres"
	@echo "make burst     - stampede BASE_URL (default localhost)"
	@echo "make burst-hot - every buyer fights over one seat"
	@echo "make down      - stop everything"

up:
	docker compose up -d --build
	@echo "waiting for readiness..."
	@until curl -fsS $(BASE_URL)/readyz >/dev/null 2>&1; do sleep 1; done
	@echo "ready at $(BASE_URL)"

down:
	docker compose --profile test down -v

logs:
	docker compose logs -f api

migrate:
	npm run migrate:dev

dev:
	docker compose up -d postgres
	npm run migrate:dev
	npm run start:dev

build:
	npm run build

test-db:
	docker compose --profile test up -d postgres-test
	@until docker compose exec -T postgres-test pg_isready -U postgres -d seats_test >/dev/null 2>&1; do sleep 1; done

test: test-db
	npm test

burst:
	./burst.sh $(BASE_URL) --requests=$(REQUESTS) --concurrency=$(CONCURRENCY) --scenario=mixed

burst-hot:
	./burst.sh $(BASE_URL) --requests=$(REQUESTS) --concurrency=$(CONCURRENCY) --scenario=hot-seat --seats=50

burst-limit:
	./burst.sh $(BASE_URL) --requests=2000 --concurrency=100 --scenario=user-limit

burst-idem:
	./burst.sh $(BASE_URL) --requests=4000 --concurrency=100 --scenario=idempotent

clean:
	rm -rf dist node_modules coverage
