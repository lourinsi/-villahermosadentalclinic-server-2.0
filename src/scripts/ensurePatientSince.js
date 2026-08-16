#!/usr/bin/env node
const { Client } = require('pg');
const { spawn } = require('child_process');

async function checkColumn(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='patients' AND column_name='patientSince' LIMIT 1;`
    );
    return res.rowCount > 0;
  } finally {
    await client.end();
  }
}

function runMigrate() {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const args = ['prisma', 'migrate', 'dev', '--name', 'add-patientSince', '--create-only'];
    const p = spawn(cmd, args, { stdio: 'inherit', shell: false });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('migrate exited ' + code))));
    p.on('error', reject);
  });
}

(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Please set DATABASE_URL in the environment before running this script.');
    process.exit(2);
  }

  console.log('Checking database for patients.patientSince column...');
  try {
    const exists = await checkColumn(databaseUrl);
    if (exists) {
      console.log('Column patients.patientSince already exists. No action required.');
      process.exit(0);
    }

    console.warn('Column patients.patientSince not found in the database.');
    console.log('Recommended action: run Prisma migrate to add the column, then run `npm run prisma:generate`.');
    console.log('To create the migration files only (no apply), set RUN_MIGRATE=1 to create a migration skeleton:');
    console.log('\n  RUN_MIGRATE=1 node src/scripts/ensurePatientSince.js\n');

    if (process.env.RUN_MIGRATE === '1') {
      console.log('Running `npx prisma migrate dev --create-only --name add-patientSince` to generate migration files...');
      await runMigrate();
      console.log('Migration files created. Review them, then run `npx prisma migrate dev` to apply.');
    }
  } catch (err) {
    console.error('Error during check:', err);
    process.exit(1);
  }
})();
