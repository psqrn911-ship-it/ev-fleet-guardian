# EV Fleet Monitor

## Run
1. `cd Backend && npm install` (no new packages are needed beyond the existing ones)
2. Copy `Backend/.env.example` to `Backend/.env` and put your MongoDB connection string in `MONGO_URI`.
3. `node server.js` and open http://localhost:3000

## Accounts
- Host: **psqrn.911@gmail.com**. On first start the server creates this account. Set `HOST_PASSWORD` in `.env`, or copy the password printed in the console (shown once).
- Anyone else uses **Request access**. They cannot sign in until the host approves them under **Access requests**.

## Sending vehicle data
Add the vehicle in the app. It shows a device key once. Your microcontroller then POSTs JSON to `/data`:
`{ "vehicle_id": "KA01EV2341", "key": "<device key>", "battery": 0-100, "voltage": V, "current": A, "temp": C, "lat": ..., "lon": ... }`
Negative current is treated as charging. Fields you do not send simply show "—".

## Notes
- Map tiles: CARTO/OpenStreetMap. Nearby chargers: OpenStreetMap (Overpass), looked up around each vehicle's last GPS position.
- Geofences are set per vehicle on the Map & geofence tab.

## Deploy on Vercel
1. Push this folder (the one containing `api/`, `Backend/`, `public/`, `vercel.json`) to a GitHub repo. `.gitignore` keeps `.env` out.
2. In Vercel: Add New > Project > import the repo. Leave Framework as "Other" and build settings empty.
3. Settings > Environment Variables: set `MONGO_URI` and `JWT_SECRET` (any long random string). Optional: `HOST_PASSWORD`.
4. MongoDB Atlas > Network Access: allow `0.0.0.0/0` (Vercel uses changing IPs). Use a strong database password.
5. Deploy. Your ESP32 must POST to `https://<your-app>.vercel.app/data` over HTTPS.
