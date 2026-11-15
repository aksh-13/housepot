#!/bin/sh
# Starts the local Postgres used for development and tests. Safe to run repeatedly.
set -e
NAME=housepot-pg
if [ -z "$(docker ps -q -f name=^${NAME}$)" ]; then
  if [ -n "$(docker ps -aq -f name=^${NAME}$)" ]; then
    docker start "$NAME" >/dev/null
  else
    docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=housepot \
      -p 127.0.0.1:54329:5432 postgres:16-alpine >/dev/null
  fi
fi
until docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; do sleep 0.5; done
docker exec "$NAME" psql -U postgres -tc "select 1 from pg_database where datname='housepot_test'" | grep -q 1 \
  || docker exec "$NAME" psql -U postgres -c "create database housepot_test" >/dev/null
echo "Postgres ready on 127.0.0.1:54329 (databases: housepot, housepot_test)"
