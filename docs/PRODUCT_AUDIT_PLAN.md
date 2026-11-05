# Product audit agent — plan

Status: idea saved, nothing built yet.

## Goal

An AI agent that shows which Allegro offers need fixing (errors, duplicates, weak descriptions)
so the team can improve the product cards. It appears as a page in the shop's existing CRM.

## Decisions so far

- **Report only for the first version.** The agent reads offers and suggests fixes; staff apply
  them by hand. It cannot change anything on Allegro.
- **Lives in the existing CRM**, not a new panel and not Telegram.
- **AI provider:** OpenAI, using the key the bot already has.

## Open questions

1. How many offers does the shop have? Needed to estimate the AI cost before a full run.
2. Which CRM is it, and what does it look like? It's a web CRM; the user will give access when
   the plan is finished.

## How it would work

1. **Offer scan:** read all offers from Allegro. The current `allegro:api:sale:offers:read`
   permission is enough.
2. **Rule checks (no AI, no cost):**
   - duplicate or near-duplicate offers
   - missing required parameters
   - titles that are too long or badly formatted
   - thin descriptions
   - too few photos
3. **AI review:**
   - spelling mistakes
   - contradictions, such as a title saying 500 g/m² while the parameters say something else
   - a suggested better title and description for each offer
4. **Report:** a quality score and a list of problems per offer, worst first. The CRM page shows
   this report.

Steps 1–3 don't depend on the CRM and can be built in this repo first.

## Later

- **Approve and publish:** a button that publishes an approved fix to Allegro. Needs the
  `allegro:api:sale:offers:write` permission, which the app doesn't have yet, and approving the
  app again.
- The bot still runs only while the owner's Mac is on. If the audit should run on a schedule, it
  needs the same 24/7 hosting that is already on the roadmap.
