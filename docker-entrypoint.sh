#!/bin/sh
set -e

# Migrations run as a separate process before the server starts. If the schema
# cannot be brought up to date we want the deploy to fail loudly rather than to
# start an instance serving against a half-migrated database.
# The runner logs its own start line, including which host it is targeting.
node dist/migrate

echo '{"msg":"starting server"}'
exec node dist/main
