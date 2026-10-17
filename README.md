# Pizza Order Book

Order tracker for restaurant staff. Staff sign in, add an order (name, surname, pizza, collection date and time), see open orders sorted by collection time, and mark each one completed once it has gone out. Orders, staff logins and sign-ins are stored in Postgres, so every device sees the same data.

## Deploy on Railway

1. Push this folder to a GitHub repository, keeping the folder layout: `server.js`, `auth.js`, `login.html` and `package.json` at the top, `public/index.html` and `scripts/add-user.js` inside their folders.
2. In Railway, create a new project and choose **Deploy from GitHub repo**. Select the repository.
3. In the same project, add a database: **New > Database > Add PostgreSQL**.
4. Open the web service, go to **Variables**, and add:
   - `DATABASE_URL` with the value `${{Postgres.DATABASE_URL}}` (use your database service's name if it is not "Postgres").
   - `STAFF_USER` and `STAFF_PASSWORD` for the first staff login (password at least 8 characters).
   - Optional `STAFF_LOGINS` for more logins (see below).
5. Under **Settings > Networking**, click **Generate Domain**, then open the link and sign in.

The `orders`, `staff_users` and `sessions` tables are created automatically on first start.

## Signing in and out

The site opens on a sign-in page. After signing in, the order screen shows "Signed in as <name>" and a **Sign out** button.

- A sign-in lasts 8 hours, or until the person clicks **Sign out**. To change the 8 hours, add a variable `SESSION_HOURS` (1 to 72).
- The sign-in cookie is dropped when the browser closes. Some browsers restore it when set to "continue where you left off"; the 8-hour limit still applies.
- When a sign-in ends, the order screen returns to the sign-in page by itself within about 10 seconds.
- Redeploying does not sign anyone out. The sign-ins are stored in the database.

## Staff logins

Logins live in the `staff_users` table. Passwords are stored as salted scrypt hashes, never as plain text, so they cannot be typed into the table by hand.

**Add several logins (no terminal needed)**

1. In Railway, open the web service, then **Variables**.
2. Create `STAFF_LOGINS` with entries in the form `username:password`, separated by commas, for example `anna:ovenhot99,ben:dough12345`.
3. Save and let the service redeploy.
4. In **Deploy Logs**, look for `Created staff login "anna"` for each new person.

Usernames use letters, numbers, `.`, `_` and `-`, and are not case-sensitive. Passwords need 8+ characters and cannot contain a comma.

**Rules**

- Logins named in the variables are only created if they do not exist yet. Changing a password in the variables does not change an existing login. Removing a login from the variables does not delete it.
- **Change a password without a terminal:** in Railway open the Postgres service, **Database > Data > staff_users**, delete that person's row, put the new password in `STAFF_LOGINS` (or `STAFF_PASSWORD` for the first login), and redeploy. The login is re-created with the new password and the person is signed out everywhere.
- **Remove a login:** delete the row in `staff_users` and remove the person from the variables, otherwise the next deploy creates the login again. Their sign-ins stop working immediately.
- **Change a password with a terminal:** run this against the same database (in a shell on the Railway service, or locally with `DATABASE_URL` set). The person is signed out everywhere:

  ```
  node scripts/add-user.js <username> <password>
  ```
- After 10 wrong passwords for one username from one address, that username is blocked from that address for 10 minutes. After 50 wrong attempts from one address in total, that address is blocked for 10 minutes.

## Change the pizza menu

Edit the `MENU` list at the top of `server.js` and redeploy.

## Run locally

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/pizzas STAFF_USER=staff STAFF_PASSWORD=choose-a-password npm start
```

Then open http://localhost:3000.

## Notes

- Completed orders stay in the database. The screen shows the last 7 days of them.
- The screen refreshes every 10 seconds, so a new order from one device appears on the others within that time.
- Dates and times are stored exactly as entered and are not converted between time zones.
