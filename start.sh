#!/bin/sh
npx prisma migrate deploy
exec node init.js
