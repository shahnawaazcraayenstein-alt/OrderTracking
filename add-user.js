'use strict';

// Usage: node scripts/add-user.js <username> <password>
// Creates a staff login, or resets the password if the username already exists.

const { Pool } = require('pg');
const { hashPassword, STAFF_USERS_SQL, SESSIONS_SQL } = require('../auth');

async function main() {
  const rawUser = process.argv[2];
  const password = process.argv[3];

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const username = (rawUser || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(username) || !password || password.length < 8) {
    console.error('Usage: node scripts/add-user.js <username> <password>');
    console.error('Username: 2 to 40 letters, numbers, dots, dashes or underscores.');
    console.error('Password: at least 8 characters.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await pool.query(STAFF_USERS_SQL);
    await pool.query(SESSIONS_SQL);
    const hash = await hashPassword(password);
    const updated = await pool.query('UPDATE staff_users SET password_hash = $2 WHERE username = $1', [username, hash]);
    if (updated.rowCount === 0) {
      await pool.query('INSERT INTO staff_users (username, password_hash) VALUES ($1, $2)', [username, hash]);
      console.log(`Created staff login "${username}".`);
    } else {
      await pool.query('DELETE FROM sessions WHERE username = $1', [username]); // a new password signs the person out everywhere
      console.log(`Updated the password for "${username}". They are signed out and must sign in again.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Could not save the login:', err.message);
  process.exit(1);
});
