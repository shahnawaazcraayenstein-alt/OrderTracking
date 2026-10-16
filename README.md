# Pizza Order Book

Order tracker for restaurant staff. Staff sign in, add an order (name, surname, pizza, collection date and time), see open orders sorted by collection time, and mark each one completed once it has gone out. Orders and staff logins are stored in Postgres, so every device sees the same data.

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a new project and choose **Deploy from GitHub repo**. Select the repository.
3. In the same project, add a database: **New > Database > Add PostgreSQL**.
4. Open the web service, go to **Variables**, and add:
   - `DATABASE_URL` with the value `${{Postgres.DATABASE_URL}}` (use your database service's name if it is not "Postgres").
   - `STAFF_USER` and `STAFF_PASSWORD` for the first staff login (password at least 8 characters).
5. Under **Settings > Networking**, click **Generate Domain**, then open the link and sign in.

The `orders` and `staff_users` tables are created automatically on first start.

## Staff logins

Logins live in the `staff_users` table. Passwords are stored as salted scrypt hashes, never as plain text, so they cannot be typed into the table by hand.

- **First login:** on the first start, if the table is empty, `STAFF_USER` and `STAFF_PASSWORD` create it. After that the variables are ignored, so changing them does not change the password.
- **More logins, or a password reset:** run this against the same database (for example in a shell on the Railway service, or locally with `DATABASE_URL` set):

  ```
  node scripts/add-user.js <username> <password>
  ```

  If the username already exists, its password is replaced.
- Until at least one login exists, the site shows a message instead of the orders.
- After 10 wrong logins from one address, that address is blocked for 10 minutes.
- A login that has just been verified is trusted for one minute, so a changed password can take up to a minute to apply.

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
