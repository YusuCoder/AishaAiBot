# Package tracking — plan

Status: plan in progress, nothing built yet.

## Goal

Warehouse staff scan the shipping label of every package. The CRM records the scan and tracks
whether the courier picked the package up, so no package gets lost. No contracts with couriers.

## Decisions so far

- **Everything is shown in the web CRM.** No Telegram alerts for tracking.
- **CRM access comes later,** once the plan is finished. The CRM's stack and design are unknown
  until then.
- **No courier contracts:** tracking data would come from Allegro.

## How it would work

1. **Scan:** when a package is packed, staff scan the label. The CRM records the time, who scanned
   it and which order it belongs to.
2. **Courier check:** the system regularly asks Allegro for the shipment's status and shows when
   the carrier has it.
3. **CRM page:** a status for every package, with problems highlighted:
   - scanned, but no courier pickup after 24 hours
   - order paid, but the package was never scanned
   - in transit with no update for 3 days
   - label scanned twice
   - barcode matches no order
4. **End-of-day view:** scanned today, picked up, and still missing.

## Allegro API (not yet confirmed on the real account)

- `GET /order/checkout-forms/{id}/shipments`: shipment numbers and carrier for an order
- `GET /order/carriers/{carrierId}/tracking?waybill=...`: tracking history
- `GET /order/carriers`: carriers Allegro knows

The check on 2026-11-04 didn't run because the Allegro login had expired. Rerun it once the bot
is running again, because it refreshes the login.

## Limits to design around

- Only Allegro orders with the shipment number attached can be tracked. Packages sold elsewhere
  would need a paid tracking service.
- Tracking depends on which carriers Allegro supports.
- The barcode on a label may not match the shipment number exactly. Test with real labels.
- Some couriers only record a package at the depot, so "picked up" really means "the carrier's
  first scan". The no-pickup warning has to allow for that delay.
- Status checks need something running 24/7, so this needs hosting.

## Open questions

1. Which couriers does the shop use, and are labels made through Wysyłam z Allegro?
2. Do staff scan with a barcode scanner or a phone?
3. A photo of a real label, with the buyer's address covered.
4. Which CRM is it? The user will give access when the plan is finished.
