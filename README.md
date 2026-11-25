# Housepot

Chores with money on the line. Everyone in a house pays a deposit into a pot. Skip or miss your chore and part of your balance goes to whoever does it.

Built for student houses, where everyone knows whose turn it is and nobody does it.

## The rules

1. Each housemate pays a deposit (default $20) by card. That is their balance.
2. Chores rotate through the housemates who have paid in.
3. On your turn you either do it and send a photo, or pay the skip price (default $5) before the deadline.
4. Miss the deadline and the skip price is taken from your balance anyway. A balance can go below zero.
5. A skipped or missed chore is open to the whole house. The first person to do it, with a photo, takes the money. That includes the person who missed it.
6. If nobody claims it, the money rolls over to the next person who does that chore on time.
7. Any housemate can dispute a "done" within 24 hours. If more than half of the others agree, it counts as a miss.
8. At the end of term everyone is cashed out and the pot restarts. Money goes back to the card that paid it; winnings on top are sent by e-Transfer.
   Leaving early cashes you out the same way, but it is not a way out of a charge: a turn waiting on you counts as skipped, you cannot leave within 24 hours of finishing a chore (it can still be disputed), and a debt written off when you leave comes back if you rejoin.
9. Optional auto-reload: save your card and it tops you back up when you hit $0.
10. Anyone can pause the house for a break. Nothing is assigned or charged while paused.

The full design, with the reasons behind each rule, is in [`docs/superpowers/specs/2026-11-14-housepot-design.md`](docs/superpowers/specs/2026-11-14-housepot-design.md).

## Two ways a house can handle money

Each house picks one when it is created. The chore rules above are the same in both.

|           | **e-Transfer** (the default)                                                                | **Card deposits** (the original design)                                        |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Paying in | Nobody pays in. Everyone starts at $0.                                                      | A deposit by card, held by the app.                                            |
| Skipping  | Always allowed; your score can go below zero.                                               | Only with enough balance.                                                      |
| Settling  | On the 1st of each month the scores become a few "A pays B" e-Transfers between housemates. | Cash-out at the end of term: card refunds, plus e-Transfers from the operator. |
| Cost      | Free. No money touches the app.                                                             | Card fees on every deposit.                                                    |
| Needs     | Twilio for texts.                                                                           | Twilio and Stripe, and the legal check on holding money (see Going live).      |

### How settling up works (e-Transfer houses)

1. On the 1st (or when someone leaves, or the house votes for it), unclaimed bounties are shared out and the scores become the fewest possible payments, at most one fewer than the number of people.
2. Each payment has a code like `HP-7K3Q`. Both people get a text and see it on `/settle`.
3. The person owed can send an Interac **money request**. Once Housepot sees it, the payer's **Pay** button opens that request, and their bank shows it already filled in. Otherwise the payer gets copy buttons for the email and code, and an "Open my bank" shortcut.
4. The payer puts the code in the e-Transfer message. When Interac's "you got money" email reaches Housepot, the payment is marked paid with nobody tapping anything. "I sent it" and "It arrived" buttons cover anyone without forwarding set up.
5. A reminder after a day, another when it is overdue (3 days). Someone with an overdue payment cannot claim bounties until it is paid.

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

- **Texts are faked.** Sign-in codes and reminders are saved, not sent. Read them at `/dev/outbox`.
- **Payments are faked.** "Pay" opens a pretend checkout page. No real money moves.
- **Interac emails are faked.** In an e-Transfer house, `/dev/inbox` stands in for Interac emailing someone's forwarding address.
- **Photos are saved to disk** under `.data/photos`.

To make time pass (reminders, missed chores), poke the scheduler by hand:

```sh
curl -X POST -H "Authorization: Bearer dev-tick-secret" http://localhost:3000/api/internal/tick
```

### Tests and checks

```sh
pnpm test        # 226 tests against a real Postgres (pnpm db:up starts it)
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
  turns.ts       done, skip, miss, claim
  disputes.ts    raising and voting
  tick.ts        the scheduler's heartbeat
  settlement.ts  cash-out, leaving, end of term
  settleup.ts    e-Transfer houses: monthly settle-up, debts, reminders
  inbound.ts     forwarded Interac emails: matching payments and money requests
  interac.ts     reading Interac's emails (wording not yet checked against real ones)
src/providers/   texts, payments, photo storage: a real and a fake version of each
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

| Variable                 | What it is                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Postgres connection string.                                                                                                      |
| `BASE_URL`               | Public address of the site. Used in text-message links and payment return pages.                                                 |
| `TICK_SECRET`            | Shared secret the scheduler sends to `/api/internal/tick`.                                                                       |
| `SMS_PROVIDER`           | `fake` or `twilio`. With `twilio`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.                                     |
| `PAYMENTS_PROVIDER`      | `fake` or `stripe`. With `stripe`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.                                                 |
| `STORAGE_PROVIDER`       | `disk` or `s3`. With `s3`: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.                  |
| `OPERATOR_PHONES`        | Comma-separated phone numbers allowed to open `/operator`, the list of e-Transfers to send.                                      |
| `INBOUND_EMAIL_PROVIDER` | `fake` (adds `/dev/inbox` and the pretend bank page) or `webhook` (real forwarded emails only). Must be `webhook` in production. |
| `INBOUND_EMAIL_DOMAIN`   | The domain of the forwarding addresses, `pay-…@this-domain`.                                                                     |
| `INBOUND_EMAIL_SECRET`   | Shared secret the mail receiver sends to `/api/webhooks/email`.                                                                  |

## Going live

Not done yet. For a pilot with **e-Transfer houses only**, steps 1 and 2 are not needed: the app never holds money. Instead, receive email for `INBOUND_EMAIL_DOMAIN` (see "Checking payments automatically") and check the Interac email wording against real emails. Note that card houses can still be created from the new-house page, and they need Stripe.

In order:

1. **Check the rules on holding money.** The app holds housemates' deposits. Before anyone outside your own house uses it, confirm Stripe's terms allow holding deposits this way and check Canadian rules for holding funds on behalf of users. This is an open question, not a solved one.
2. **Stripe.** Create an account, set `PAYMENTS_PROVIDER=stripe` and the two keys. Add a webhook pointing at `https://YOUR-DOMAIN/api/webhooks/payments` for the `checkout.session.completed` event. Test with Stripe's test cards first. The Stripe code path has not been run against a real Stripe account yet.
3. **Twilio.** Buy a number, complete the registration Canadian numbers need, set `SMS_PROVIDER=twilio` and the three values. Also untested against the real service.
4. **A database and photo storage.** Any managed Postgres and any S3-compatible bucket (S3, Cloudflare R2).
5. **A cluster and a domain.** Any Kubernetes cluster with the nginx ingress controller and cert-manager. Put your domain in `k8s/overlays/prod/ingress.yaml` and `kustomization.yaml`, fill in `secret.env`, then `kubectl apply -k k8s/overlays/prod`.
6. **Set `OPERATOR_PHONES`** to your number so you can see pending e-Transfers at `/operator`.
7. **Let the cluster pull the image.** The repo is private, so the image on ghcr.io is too. Either make the package public, or create a pull secret named `ghcr-pull` in the `housepot` namespace (`kubectl create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=aksh-13 --docker-password=<a token with read:packages>`). The production overlay already refers to it.

## Known limits

- Negative balances mean the pot can owe more than it holds until the person in debt pays. Whoever runs the app covers the gap at cash-out.
- In an e-Transfer house nothing forces anyone to pay. An overdue debt blocks claiming bounties and everyone can see it, and that is all.
- Settling up closes any chore that is up for grabs and shares its money out, like the end of term in a card house.
- "Done" needs a photo, but nobody checks the photo unless a housemate disputes it.
- One house per person.
- Splitting bills (the Splitwise side) is not built.
