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
- **Photos are saved to disk** under `.data/photos`.

To make time pass (reminders, missed chores), poke the scheduler by hand:

```sh
curl -X POST -H "Authorization: Bearer dev-tick-secret" http://localhost:3000/api/internal/tick
```

### Tests and checks

```sh
pnpm test        # 186 tests against a real Postgres (pnpm db:up starts it)
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

| Variable            | What it is                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | Postgres connection string.                                                                                     |
| `BASE_URL`          | Public address of the site. Used in text-message links and payment return pages.                                |
| `TICK_SECRET`       | Shared secret the scheduler sends to `/api/internal/tick`.                                                      |
| `SMS_PROVIDER`      | `fake` or `twilio`. With `twilio`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.                    |
| `PAYMENTS_PROVIDER` | `fake` or `stripe`. With `stripe`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.                                |
| `STORAGE_PROVIDER`  | `disk` or `s3`. With `s3`: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. |
| `OPERATOR_PHONES`   | Comma-separated phone numbers allowed to open `/operator`, the list of e-Transfers to send.                     |

## Going live

Not done yet. In order:

1. **Check the rules on holding money.** The app holds housemates' deposits. Before anyone outside your own house uses it, confirm Stripe's terms allow holding deposits this way and check Canadian rules for holding funds on behalf of users. This is an open question, not a solved one.
2. **Stripe.** Create an account, set `PAYMENTS_PROVIDER=stripe` and the two keys. Add a webhook pointing at `https://YOUR-DOMAIN/api/webhooks/payments` for the `checkout.session.completed` event. Test with Stripe's test cards first. The Stripe code path has not been run against a real Stripe account yet.
3. **Twilio.** Buy a number, complete the registration Canadian numbers need, set `SMS_PROVIDER=twilio` and the three values. Also untested against the real service.
4. **A database and photo storage.** Any managed Postgres and any S3-compatible bucket (S3, Cloudflare R2).
5. **A cluster and a domain.** Any Kubernetes cluster with the nginx ingress controller and cert-manager. Put your domain in `k8s/overlays/prod/ingress.yaml` and `kustomization.yaml`, fill in `secret.env`, then `kubectl apply -k k8s/overlays/prod`.
6. **Set `OPERATOR_PHONES`** to your number so you can see pending e-Transfers at `/operator`.
7. **Let the cluster pull the image.** The repo is private, so the image on ghcr.io is too. Either make the package public, or create a pull secret named `ghcr-pull` in the `housepot` namespace (`kubectl create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=aksh-13 --docker-password=<a token with read:packages>`). The production overlay already refers to it.

## Known limits

- Negative balances mean the pot can owe more than it holds until the person in debt pays. Whoever runs the app covers the gap at cash-out.
- "Done" needs a photo, but nobody checks the photo unless a housemate disputes it.
- One house per person.
- Splitting bills (the Splitwise side) is not built.
