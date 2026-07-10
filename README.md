# Aaravam — Onam Sadhya 2026 — DSR White Waters

Registration, coupon, slot booking and entry-scanning app for the Aaravam Onam Sadhya on 5th September 2026.

See **Onam_Sadhya_Web_App_Deployment_Guide.docx** for full step-by-step deployment instructions (no coding experience required).

## Quick reference

- `server.js` — the app (Express + Postgres)
- `db.js` — database schema and connection
- `public/register.html` — the link posted to the residents' WhatsApp group
- `public/admin.html` — committee page (`?page=admin`)
- `public/scanner.html` — entrance scanner page (`?page=scan`)
- `public/guest.html` — opened automatically from each person's coupon link

## Excel report

On the Admin page (`?page=admin`), click **Download Excel Report** to get a `.xlsx` file with every registration (name, flat, phone, adults/kids, amount, payment status) on one sheet and every individual coupon (slot, checked-in status) on a second sheet. Downloadable any time, as many times as you like.

## Environment variables

See `.env.example` for the full list. Set these in Railway's Variables tab, not in a local `.env` file.

## Running locally (optional, for testing only)

```
npm install
DATABASE_URL=postgres://... ADMIN_PIN=1234 SCANNER_PIN=5678 UPI_ID=you@upi node server.js
```
