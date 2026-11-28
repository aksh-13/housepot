# Housepot

Chores with money on the line. Let your chore expire and what it is worth comes off your balance and goes to whoever does it instead.

Built for student houses, where everyone knows whose turn it is and nobody does it.

## The rules

1. Chores rotate through the housemates. Whoever adds a chore picks who takes the first turn (anyone in the house); after that it goes round in order. A bigger house can split into teams that take turns being on duty (see Teams).
2. Every chore has a **worth**, agreed by the house. While the house has only the person setting it up, they decide. After that, a new chore, or a new worth for an existing one, needs more than half of the other housemates to agree within three days. A new chore gets no turns until then; an existing one keeps its old worth.
3. There is no paying to skip. On your turn you do it and send one to four photos before the deadline.
4. The house approves it: more than half of the other housemates saying "Looks done" makes it count, and more than half saying "Not done" rejects it. If neither happens within 48 hours, it counts. Proof sent before the deadline is on time, however long the vote takes. Nothing is paid until it counts.
5. Let the deadline pass with nothing sent (or with proof the house rejects) and the chore **expires**: its worth comes off your balance, which can go below zero.
6. An expired chore is open to the rest of the house. The first person to do it and send photos takes its worth, once the house approves. The person it expired on cannot claim it back, or being late would cost nothing.
7. If nobody claims it, the money rolls over to the next person who does that chore on time.
8. Can't make your turn? Ask a housemate to take it, optionally doing one of theirs in exchange. It moves only if they accept, stays yours until then, and lapses at the deadline. A swap does not reshuffle the rotation.
9. In a card house, at the end of term everyone is cashed out and the pot restarts: money goes back to the card that paid it, and winnings on top are sent by e-Transfer. In an e-Transfer house (the default), nobody pays in and housemates square up with each other whenever they choose.
   Leaving is not a way out of a charge: a turn waiting on you counts as expired, you cannot leave while the house is still voting on proof you sent, and a debt written off when you leave comes back if you rejoin.
10. Anyone can pause the house for a break. Nothing is assigned or charged while paused.

Someone new is walked through it the first time they open the app: the rules, then (starting a house) the chores and their worth, where to get paid and the invite link, or (joining) the house's chores and their worth, where to get paid and which team they are on. It can be reopened from Settings.

The full design, with the reasons behind each rule, is in [`docs/superpowers/specs/2026-11-14-housepot-design.md`](docs/superpowers/specs/2026-11-14-housepot-design.md).

## Bills

In a house that settles up by e-Transfer, the same balance also tracks shared bills.

- Anyone adds a bill: what it was, the total, who paid, and who shares it. Each sharer's part moves from their balance to the payer's.
- **Split equally**, or **by receipt**: type the subtotal, the total paid, and what each person's own items came to. Anything left of the subtotal is shared equally, and tax and tip are spread in proportion to what each person had. On a $50 subtotal that came to $56.50, $30 of items costs $33.90 and $20 of items costs $22.60.
- The parts always add up to the total. An odd cent goes to whoever paid.
- The home screen shows the fewest payments that would square the house up right now. They become real debts at the next settle-up.
- Any housemate can edit or delete a bill until a settle-up has happened. Every change shows in the activity feed, and nothing is erased from the ledger: an edit or delete writes opposite entries.

## Teams

A bigger house can split into cleaning teams that take turns being on duty: one team for a set number of weeks (one to eight), then the next, round and round. Set it up on the Teams tab. A house with no teams works exactly as before.

- **Team chores.** Each chore is either for "the team on duty" or for "one person at a time". A team chore's turn belongs to whichever team is on duty when it is due.
- **Who has it.** Team chores are spread across the team so everyone gets one before anyone gets two, and the same chore moves round the team week to week. Anyone in the house can change who has one, on the Teams tab or with "I'll take it".
- **Doing it.** Whoever has it is named and reminded, but anyone on the team can do it, with a photo.
- **Missing it.** If nobody on the team does it by the deadline, its worth is split equally between everyone on the team, and the chore is open to the rest of the house as usual. Nobody on that team can claim it back.
- **Setting it up.** Starting a house asks "How does your house share chores?": everyone takes turns, or teams take turns on duty (how many teams, and how many weeks each). Everyone who joins picks their team, and the House page asks to place anyone who is on no team.
- **Nudges.** One-tap messages to the team on duty from the House page, like "Garbage is full". A house can add its own. Each goes out at most once an hour.

## On a phone

Housepot is a website, but it can sit on a phone's home screen like an app: on an iPhone tap Share, then "Add to Home Screen"; on Android open the browser menu and choose "Install app". It then opens full screen with its own icon. The manifest is `src/app/manifest.ts` and the icons are in `public/icons`.

## Two ways a house can handle money

Each house picks one when it is created. The chore rules above are the same in both.

|           | **e-Transfer** (the default)                                                             | **Card deposits** (the original design)                                        |
| --------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Paying in | Nobody pays in. Everyone starts at $0.                                                   | A deposit by card, held by the app.                                            |
| Expiring  | Its worth comes off your score, which can go below zero.                                 | Its worth comes off your balance, which can go below zero.                     |
| Settling  | Whenever housemates choose: the scores become a few "A pays B" e-Transfers between them. | Cash-out at the end of term: card refunds, plus e-Transfers from the operator. |
| Cost      | Free. No money touches the app.                                                          | Card fees on every deposit.                                                    |
| Bills     | Yes.                                                                                     | No.                                                                            |
| Needs     | A way to send sign-in codes (email or texts).                                            | The same, plus Stripe and the legal check on holding money (see Going live).   |

### How settling up works (e-Transfer houses)

1. Nothing is settled on a date: housemates settle when they choose to. When someone leaves, or any housemate presses **Request all payments** on the House page, unclaimed bounties are shared out and the scores become the fewest possible payments, at most one fewer than the number of people.
2. Each payment has a code like `HP-7K3Q`. Both people get a text and see it on `/settle`.
3. The person owed can send an Interac **money request**. Once Housepot sees it, the payer's **Pay** button opens that request, and their bank shows it already filled in. Otherwise the payer gets copy buttons for the email and code, and an "Open my bank" shortcut.
4. The payer sends the e-Transfer and presses **I've paid**. That marks it paid and tells the other person; nobody has to confirm. The person owed can also press **Mark as paid**. With automatic checking on, the code in the e-Transfer message lets Interac's "you got money" email mark it paid with nobody tapping anything.
5. Two housemates can also settle just between themselves at any time, with **Pay** or **Request** next to that person in "To square up". It creates one payment, leaves everyone else alone and does not lock any bills.
6. A reminder after a day, another when it is overdue (3 days). Someone with an overdue payment cannot claim bounties until it is paid.

There is no public way to open a bank's e-Transfer form already filled in, and Interac's API is only for registered businesses, at a fee per transfer. The request link is the closest free thing.

### Checking payments automatically

Each person gets a private address, `pay-<16 hex>@INBOUND_EMAIL_DOMAIN`, shown in Settings with Gmail and Outlook steps. They add one filter that forwards only emails from `interac.ca` there. Gmail first sends a confirmation code to that address; Housepot shows it in Settings so they can finish.

Something has to receive email for that domain and post each email to `POST /api/webhooks/email` with `Authorization: Bearer $INBOUND_EMAIL_SECRET` and this JSON:

```json
{
  "messageId": "<...>",
  "to": "pay-...@your-domain",
  "from": "notify@payments.interac.ca",
  "subject": "...",
  "text": "plain-text body",
  "authenticated": true
}
```

`authenticated` must be the receiving service's own DKIM check for the sender's domain. Emails that fail it are recorded and ignored, so a faked "you got paid" email cannot clear a debt. Two free ways to receive the mail: a Cloudflare Email Routing catch-all rule sending to an Email Worker (the Worker parses the message, checks DKIM, and posts the JSON), or SendGrid Inbound Parse (its `dkim` field says whether the signature passed). Neither is set up yet.

**The Interac email wording is a guess.** `src/domain/interac.ts` reads the amount, the sender's name, the code and the request link with patterns written without seeing a real Interac email. Before relying on it, send yourselves a $1 e-Transfer and a $1 money request, look at the raw emails, and adjust `interac.ts`, `fakeInterac.ts` and `test/inbound.test.ts` to match.

Locally, `INBOUND_EMAIL_PROVIDER=fake` adds `/dev/inbox` (pretend Interac emails, and "settle up my house now") and a pretend bank page for request links, so you can run the whole flow with no email set up.

## Run it on your laptop

You need Node 20, pnpm, and Docker running.

```sh
pnpm install
cp .env.example .env.local
pnpm db:up && pnpm db:migrate
pnpm dev
```

Open http://localhost:3000. Nothing outside your laptop is needed:

- **Texts and emails are faked.** Sign-in codes and reminders are saved, not sent. Read them at `/dev/outbox`. Sign-in is by phone number unless you set `SIGN_IN=email`.
- **Payments are faked.** "Pay" opens a pretend checkout page. No real money moves.
- **Interac emails are faked.** In an e-Transfer house, `/dev/inbox` stands in for Interac emailing someone's forwarding address.
- **Photos are saved to disk** under `.data/photos`.

To make time pass (reminders, missed chores), poke the scheduler by hand:

```sh
curl -X POST -H "Authorization: Bearer dev-tick-secret" http://localhost:3000/api/internal/tick
```

### Tests and checks

```sh
pnpm test        # 418 tests against a real Postgres (pnpm db:up starts it)
pnpm lint        # Biome: lint and formatting
pnpm typecheck
pnpm build
```

## Run it on Kubernetes, locally

```sh
pnpm k8s:up      # creates a cluster inside Docker, builds the image, deploys everything
pnpm k8s:down    # deletes the cluster
```

Open http://localhost:8642. The script uses [kind](https://kind.sigs.k8s.io) (Kubernetes in Docker) and downloads it into `.bin/` if you do not have it.

The script only ever talks to its own cluster, through its own kubeconfig file at `.kube/kind-config`. It does not read or change `~/.kube/config`. When you poke around by hand, pass the same file:

```sh
alias k="kubectl --kubeconfig .kube/kind-config -n housepot"
k get all                    # everything that is running
k logs deploy/web            # the app's logs
k logs deploy/web -c migrate # the migration that ran before the app started
k get cronjob,jobs           # the scheduler and its recent runs
k describe hpa web           # the autoscaler
k delete pod -l app.kubernetes.io/component=web   # kill the pods and watch them come back
```

### What each Kubernetes object is for

| Object                   | File                                   | What it does here                                                                                                               |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Deployment `web`         | `k8s/base/web-deployment.yaml`         | Keeps two copies of the app running and swaps them one at a time on a new release, so there is no downtime.                     |
| Init container `migrate` | same file                              | Runs database migrations before the app starts. A database lock stops two pods migrating at once.                               |
| Probes                   | same file                              | `startup` waits for boot, `readiness` only sends traffic when the database is reachable, `liveness` restarts a stuck pod.       |
| Service `web`            | `k8s/base/web-service.yaml`            | One stable name inside the cluster that spreads requests across the ready pods.                                                 |
| HorizontalPodAutoscaler  | `k8s/base/web-hpa.yaml`                | Adds pods (2 up to 6) when CPU use passes 70%. Needs metrics-server, which kind does not ship, so locally it shows `<unknown>`. |
| PodDisruptionBudget      | `k8s/base/web-pdb.yaml`                | Keeps at least one pod up while a node is drained for maintenance.                                                              |
| CronJob `tick`           | `k8s/base/tick-cronjob.yaml`           | Every 5 minutes, calls the app's tick endpoint: hands out turns, sends reminders, charges misses, settles at term end.          |
| ConfigMap and Secret     | generated by each overlay              | Settings and passwords, kept out of the image. Changing them rolls the pods.                                                    |
| StatefulSet `postgres`   | `k8s/overlays/local/postgres.yaml`     | The database, with its own disk (a PersistentVolumeClaim). Local only.                                                          |
| Deployment `minio`       | `k8s/overlays/local/minio.yaml`        | S3-compatible photo storage. Local only.                                                                                        |
| NodePort Service         | `k8s/overlays/local/web-nodeport.yaml` | How your browser reaches the local cluster.                                                                                     |
| Ingress                  | `k8s/overlays/prod/ingress.yaml`       | How the internet reaches the production cluster, with HTTPS.                                                                    |

`k8s/base` is what every environment shares. `k8s/overlays/local` and `k8s/overlays/prod` add what differs. [Kustomize](https://kustomize.io) (built into `kubectl`) merges them: `kubectl kustomize k8s/overlays/local` prints the result.

## How the code is laid out

```
src/domain/      the rules, as plain functions that take a database and a time
  ledger.ts      every money movement, double entry; balances are always derived
  turns.ts       handing out turns, expiring them, team reassignment
  approvals.ts   proof photos and the house's vote on every finished chore
  worth.ts       agreeing on what each chore is worth
  swaps.ts       asking a housemate to take a turn
  tick.ts        the scheduler's heartbeat
  settlement.ts  cash-out, leaving, end of term
  settleup.ts    e-Transfer houses: settling up (one person or the whole house), debts, reminders, the live "to square up" list
  split.ts       who owes what on a bill (plain arithmetic, also used by the form's preview)
  bills.ts       shared bills: add, edit, delete, and their ledger entries
  teams.ts       cleaning teams: who is on duty, who is on which team, nudges
  inbound.ts     forwarded Interac emails: matching payments and money requests
  interac.ts     reading Interac's emails (wording not yet checked against real ones)
src/providers/   texts, email, payments, photo storage: a real and a fake version of each
src/settings.ts  deployment settings read from the environment
src/app/         screens, form actions, API routes (Next.js)
migrations/      the database schema
test/            one file per domain module
k8s/             Kubernetes manifests
.github/         CI pipeline
```

All rules live in `src/domain` and are tested without the web layer. If you change a rule, change its test first.

## CI

`.github/workflows/ci.yml` runs on every pull request and push to `main`:

| Job     | What it proves                                                                 |
| ------- | ------------------------------------------------------------------------------ |
| `check` | Lint, types, all tests against Postgres, production build.                     |
| `k8s`   | Both overlays render and match the Kubernetes schemas.                         |
| `image` | The container builds. On `main` it is published to `ghcr.io/aksh-13/housepot`. |
| `smoke` | The app deploys to a fresh kind cluster, answers, and the tick job runs.       |

`.github/workflows/deploy.yml` deploys a published image to a real cluster. It is manual and does nothing until you add the two secrets named at the top of the file.

## Settings

| Variable                             | What it is                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                       | Postgres connection string.                                                                                                                                                               |
| `BASE_URL`                           | Public address of the site. Used in text-message links and payment return pages.                                                                                                          |
| `TICK_SECRET`                        | Shared secret the scheduler sends to `/api/internal/tick`.                                                                                                                                |
| `SMS_PROVIDER`                       | `fake` or `twilio`. With `twilio`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.                                                                                              |
| `PAYMENTS_PROVIDER`                  | `fake` or `stripe`. With `stripe`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.                                                                                                          |
| `STORAGE_PROVIDER`                   | `disk`, `db` (photos kept in the database, nothing else to set up) or `s3`. With `s3`: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.               |
| `OPERATOR_PHONES`, `OPERATOR_EMAILS` | Comma-separated phone numbers and emails allowed to open `/operator`, the list of e-Transfers to send.                                                                                    |
| `SIGN_IN`                            | `phone` (a texted code, the default) or `email` (an emailed code). Reminders go the same way.                                                                                             |
| `EMAIL_PROVIDER`                     | Used when `SIGN_IN=email`. `fake` (saved to `/dev/outbox`), `smtp` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) or `resend` (`RESEND_API_KEY`). Both real ones need `EMAIL_FROM`. |
| `INBOUND_EMAIL_PROVIDER`             | `fake` (adds `/dev/inbox` and the pretend bank page), `webhook` (real forwarded emails only) or `off` (no checking; people use "I sent it" and "It arrived"). Never `fake` in production. |
| `CARD_HOUSES`                        | `on` or `off`. `off` means e-Transfer houses only, and closes the pretend checkout and the payments webhook. Set `off` in production until Stripe is set up.                              |
| `INBOUND_EMAIL_DOMAIN`               | The domain of the forwarding addresses, `pay-…@this-domain`.                                                                                                                              |
| `INBOUND_EMAIL_SECRET`               | Shared secret the mail receiver sends to `/api/webhooks/email`.                                                                                                                           |

## Going live

### Now: e-Transfer houses, no card payments

The app never holds money in this setup, so it needs no payment account. It has not been run in production yet, and neither real email sender has been run against the live service.

1. **A host and a database.** Anything that runs the `Dockerfile`, plus any managed Postgres. Run `node scripts/migrate.mjs` before each release (the Kubernetes manifests do this in an init container).
2. **Production settings.** These four matter for safety; the production overlay in `k8s/overlays/prod` already sets them.
   - `CARD_HOUSES=off`: nobody can start a card house, and the pretend checkout and the payments webhook are closed. Without it, the pretend payment provider would let anyone credit a balance.
   - `INBOUND_EMAIL_PROVIDER=off`: no pretend Interac pages. People mark debts with "I sent it" and "It arrived".
   - `SIGN_IN=email` with `EMAIL_PROVIDER=smtp` or `resend`, never `fake`: with a fake sender, `/dev/outbox` shows everyone's sign-in codes. In production the app refuses to start sending if `EMAIL_PROVIDER` is not set at all.
   - `TICK_SECRET`: a long random string.
3. **An email sender.**
   - No domain yet: `EMAIL_PROVIDER=smtp` with a Gmail account and an app password (`SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`). The host must allow outgoing SMTP; Railway's Hobby plan does not.
   - With a domain: `EMAIL_PROVIDER=resend`, which works over HTTPS on any host.
4. **`BASE_URL`** set to the public address, and **`OPERATOR_EMAILS`** set to your own.
5. **Photo storage.** `STORAGE_PROVIDER=db` keeps photos in the database with nothing else to set up. For more volume use any S3-compatible bucket (S3, Cloudflare R2). `STORAGE_PROVIDER=disk` needs a persistent disk and a single copy of the app.
6. **The tick.** Something must send `POST /api/internal/tick` with `Authorization: Bearer $TICK_SECRET` every five minutes. Without it no turns are handed out, no reminders go out and no settle-up happens. The Kubernetes manifests include a CronJob for it.
7. **On Kubernetes:** any cluster with the nginx ingress controller and cert-manager. Put your domain in `k8s/overlays/prod/ingress.yaml` and `kustomization.yaml`, fill in `secret.env`, then `kubectl apply -k k8s/overlays/prod`. If the image on ghcr.io is private, create a pull secret named `ghcr-pull` in the `housepot` namespace (`kubectl create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=aksh-13 --docker-password=<a token with read:packages>`), or make the package public and delete that patch from the overlay.

### On Vercel

`vercel.json` runs the migrations before each build. They take a session lock, so they use `DATABASE_URL_UNPOOLED` (a direct connection, which the Neon integration provides) when it is set, and `DATABASE_URL` otherwise. The app itself should use a pooled `DATABASE_URL`.

- Photos need `STORAGE_PROVIDER=db` (kept in the database) or `s3`; there is no disk to save to.
- Vercel's own cron cannot call the tick on the Hobby plan (once a day at most, and it sends GET). Use an outside scheduler to send the POST every five minutes.
- A request is capped at 4.5 MB, so a proof photo that could not be shrunk in the browser is rejected.

### Later

- **Card houses.** First check the rules on holding money: confirm Stripe's terms allow holding deposits this way and check Canadian rules for holding funds on behalf of users. This is an open question, not a solved one. Then create a Stripe account, set `PAYMENTS_PROVIDER=stripe` and the two keys, add a webhook at `https://YOUR-DOMAIN/api/webhooks/payments` for `checkout.session.completed`, and set `CARD_HOUSES=on`. The Stripe code path has not been run against a real Stripe account.
- **Texts instead of email.** `SIGN_IN=phone` and `SMS_PROVIDER=twilio` need a Twilio number and the registration Canadian numbers require, which takes days.
- **Checking payments automatically.** Receive email for `INBOUND_EMAIL_DOMAIN`, set `INBOUND_EMAIL_PROVIDER=webhook`, and check the Interac email wording against real emails first (see "Checking payments automatically").

## Known limits

- Negative balances mean the pot can owe more than it holds until the person in debt pays. Whoever runs the app covers the gap at cash-out.
- In an e-Transfer house nothing forces anyone to pay. An overdue debt blocks claiming bounties and everyone can see it, and that is all.
- Settling up closes any chore that is up for grabs and shares its money out, like the end of term in a card house.
- A finished chore counts after 48 hours unless most of the house says it was not done, so a house that never votes approves everything.
- Item-by-item receipts and reading a receipt from a photo are planned next (see `docs/superpowers/specs/2026-11-27-approvals-and-chore-worth-design.md`).
- One house per person.
- Bills are split equally or by per-person receipt amounts. Item-by-item receipts, percentages, repeating bills and reading a receipt from a photo are not built.
- Bills are for e-Transfer houses only.
