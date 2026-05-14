#!/bin/sh
# Idempotently create the 'blockscout' database in the shared hara-postgres.
# Connects via env PGHOST/PGUSER/PGPASSWORD and the admin 'postgres' database.

set -e

# Wait for the server to be ready (it's marked healthy by compose, but this is a belt-and-suspenders)
until pg_isready -d postgres; do
  echo "▶ Waiting for Postgres..."
  sleep 1
done

# Create the blockscout database if it doesn't exist
if psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'blockscout'" | grep -q 1; then
  echo "✔ Blockscout database already exists"
else
  psql -d postgres -c "CREATE DATABASE blockscout"
  echo "✔ Blockscout database created"
fi
