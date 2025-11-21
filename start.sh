#!/bin/sh
npx prisma migrate deploy
node init.js
