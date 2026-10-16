# Pizza Order Book

Order tracker for restaurant staff. Staff add an order (name, surname, pizza, collection date and time), see open orders sorted by collection time, and mark each one completed once it has gone out. Orders are stored in Postgres, so every device sees the same list.

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a new project and choose **Deploy from GitHub repo**. Select the repository.
3. In the same project, add a database: **New > Database > Add PostgreSQL**.
4. Open the web service, go to **Variables**, and add:
   - `DATABASE_URL` with the value `${{Postgres.DATABASE_URL}}` (use your database service's name if it is not "Postgres").
   - `STAFF_PASSWORD` with a password for your staff. Optional `STAFF_USER` (defaults to `staff`).
5. Under **Settings > Networking**, click **Generate Domain**, then open the link.

The `orders` table is created automatically on first start.

## Staff login

If `STAFF_PASSWORD` is set, the browser asks for a username and password before showing anything. Without it, anyone with the link can view and change orders.

## Change the pizza menu

Edit the `MENU` list at the top of `server.js` and redeploy.

## Run locally

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/pizzas npm start
```

Then open http://localhost:3000.

## Notes

- Completed orders stay in the database. The screen shows the last 7 days of them.
- The screen refreshes every 10 seconds, so a new order from one device appears on the others within that time.
- Dates and times are stored exactly as entered and are not converted between time zones.
