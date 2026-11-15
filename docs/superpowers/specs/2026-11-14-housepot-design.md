# Housepot: design

Working name. Date: 2026-11-14. Status: approved by the owner on 2026-11-14, with the owner's changes folded in (negative balances with optional auto-reload, race after the deadline, photo proof, Kubernetes and CI, whole thing built in one phase).

Built by the owner and one friend, so the repo must be easy for a second person to pick up: a README with setup steps, one command to run locally, and CI that checks every change.

## Intent and why

Student houses do not get chores done. Everyone knows whose turn it is; people just do not do it, and nothing happens when they skip. Existing chore apps organize the chores, which was never the problem, so houses stop using them within weeks.

Housepot makes skipping cost real money that the person has already put in. Every housemate pays a deposit into a house pot. Skip or miss your chore and part of your balance moves to whoever does it instead. Do your chores and you keep your money. Cover for others and you profit.

The owner wants a project that gets real users. First users are the owner's own house, then other McMaster student houses in Hamilton. It spreads one house at a time through a shared link.

## Goals

- A house of 3 to 8 people can set up in under five minutes from one shared link, with no app install.
- Each chore turn ends in exactly one of: done, skipped (paid), or missed (auto-charged). Nobody has to nag or collect.
- Balances are backed by real money already paid in, so a charge is felt immediately.
- The owner's own house uses it for a full month without the owner pushing.

## Non-goals (first version)

- Shared expenses and bill splitting (the Splitwise side). Later.
- A bot inside iMessage or any other chat. Considered; the owner chose to keep it a web app.
- One person in several houses.
- Hamilton garbage-day lookup by address.
- Native mobile apps.
- Automatic bank payouts of winnings.

## Anti-goals

- It must not need the one organized housemate to run it by hand each week. If it does, it is another dead chore app.
- It must not lose track of anyone's money. Every cent in a balance must trace back to ledger entries.
- It must not become a group chat people mute. Texts are few and only about your own turn or money.

## How it works

### House setup

1. One person creates a house: name, deposit amount (default $20), currency CAD.
2. They get an invite link to paste in the house chat.
3. Each housemate opens the link, signs in with a phone number and a texted code, and pays the deposit by card.
4. A housemate is active once their deposit is paid. Chores rotate only among active housemates.

### Chores

Each chore has: a name, a schedule (weekly on a chosen day, or every N days), a deadline time on that day, a skip price (default $5), and a rotation order. Any housemate can add or edit chores in the first version (see "Left to the builder").

### A turn

```
assigned ──► done                      (no money moves)
         ├─► skipped  (person taps "pay to skip" before the deadline)
         └─► missed   (deadline passes with no action)
```

- Skipped or missed: the skip price moves out of that person's balance and becomes a bounty on that chore.
- Race after the deadline (owner's decision): once a bounty is open, anyone in the house can win it, including the person whose turn it was. So doing your chore late gets your own money back, unless a housemate beats you to it.
- Claiming needs proof (owner's decision): to claim a bounty you submit a photo of the finished chore. The first valid claim wins the bounty. The claim and the proof are one step, so there is no reservation to expire. (That they are one step is my reading of the owner's "claim step accompanied with proof".)
- Marking your own turn done before the deadline also needs a photo. (My reading of the owner's "there needs to be some evidence".)
- If nobody does it before the chore's next turn, the bounty rolls onto the next turn, so the next person earns extra for doing it. (My call, not the owner's.)
- A house can be paused by any housemate (reading week, December, summer). While paused, no turns are assigned and nothing is charged; the pause and who set it show in the activity feed. There is no per-person away mode in the first version: someone away pays to skip or swaps informally. (My call.)

What a housemate sees on their turn:

```
🗑  Garbage: tonight by 9pm. Your turn.
    [ Done 📷 ]   [ Pay $5 to skip ]
```

What everyone sees after a skip or a miss:

```
🗑  Garbage is open: +$5 to whoever does it   [ Claim with photo 📷 ]
```

### Marking done, and disputes

Every "done" and every claim carries a photo that the whole house can see in the activity feed. Nobody has to approve it. Any other housemate can dispute it within 24 hours. The dispute passes when more than half of the active housemates other than the person disputed agree; the person who raised it counts as one of them. In a three-person house that means both others must agree. (My call.)

- Disputed "done" on your own turn: treated as missed.
- Disputed claim on a bounty: the payout is reversed and the bounty reopens. No extra charge.

### Balances and the pot

- Every money movement is one row in an append-only ledger: deposit, top-up, skip, miss, bounty payout, dispute reversal, cash-out. A balance is the sum of a person's rows.
- Balances carry over month to month. On the first of each month, anyone below the house deposit amount is asked to top back up to it. This keeps card fees low, because only people who lost money pay again.
- A balance can go below zero (owner's decision). Misses keep charging and bounties keep paying out. A negative balance is a debt shown to the whole house, and it is added to that person's next top-up. They cannot "pay to skip" while their balance is below the skip price.
- Auto-reload is an option each person can switch on (owner's decision): their card is saved, and when their balance drops to zero or below it is charged enough to bring them back up to the house deposit amount. Off by default.
- Known risk of allowing negative balances: the pot can owe more than it holds until the person in debt pays. During the pilot the operator covers any gap at cash-out.
- Anyone above the deposit amount just holds the extra as balance.

House screen:

```
House pot
  Akshaj  $25  ▲
  Priya   $20
  Sam     $10  ▼   top-up due Dec 1
```

### Getting money out

- Each house has a settlement date, default the end of the school term (late December, late April, late August). On that date everyone is cashed out and the pot restarts with fresh deposits. This keeps card refunds inside the provider's refund window and keeps manual e-Transfers rare. (My call.)
- A housemate can also cash out when they leave the house. The house can close the pot early if more than half of active housemates agree.
- Cash-out refunds to the person's card up to what they paid in by card. Anything above that (winnings) is sent by the operator by e-Transfer in the first version. (My call. Automatic payouts need identity checks for every housemate, which is too much friction to start.)

### Reminders (text messages)

- Morning of your turn: what and by when, with the link.
- Two hours before the deadline, if still not done.
- When a bounty opens: one text to the other housemates.
- When your balance changes because of a miss or a dispute.
- Monthly top-up request.

## Constraints

- Canada, CAD, phone-first. Most use is on a phone browser from a link.
- The owner has a full-time job and full-time school: the first version must be small and cheap to run.
- Card processing fees are not returned on refunds. On a $20 deposit the fee is roughly $0.90. The deposit screen shows the fee on top of the deposit so balances stay whole numbers. (My call.)
- Scope of the first version: the owner's own house as a pilot, plus a few houses the owner invites personally. Any house can create itself from the app, but there is no admin dashboard, abuse control, or payout queue yet. The owner is the operator: holds the payment account, sends the rare e-Transfers, and absorbs any card chargebacks during the pilot.
- Holding other people's money carries legal and payment-provider rules. The first version is a pilot in the owner's own house. Before opening to the public, confirm the payment provider's terms allow holding deposits this way and check Canadian rules for holding funds on behalf of users. This is an open risk, not a solved one.

## Approaches

### Product shape

| Approach | Trade-off | Outcome |
|---|---|---|
| A. Web app from a shared link, text reminders | Works for any house regardless of chat app; texts cost a little | **Picked** by me, owner did not object |
| B. Bot in Discord or Telegram | Fastest build; excludes houses on iMessage or Instagram | Dropped: caps users from day one |
| C. Native phone app | Best notifications; slowest, and every housemate must install | Dropped: install friction is what kills chore apps |

### What makes people follow through

| Approach | Trade-off | Outcome |
|---|---|---|
| Owe-later fines | Simple; but owing is what housemates already ignore | Replaced |
| Public pressure only | No money needed; easy to mute, wears off | Kept only as light reminders |
| **Prepaid deposit that drains** | Loss is felt right away, no collecting; needs real money handling | **Picked by the owner** |

### Where the real money sits

| Approach | Trade-off | Outcome |
|---|---|---|
| One housemate holds the pot | No fees, no rules; needs trust in a banker | Recommended by me, not chosen |
| Numbers only, settle later | Easiest; loses the point of prepaying | Dropped |
| **The app holds it (card payments)** | Feels real; fees, provider and legal rules, more work | **Picked by the owner** |

## How it gets built (my calls)

The owner asked for Kubernetes and a CI pipeline, to learn them and to show them on a resume. The rest are my calls.

- Next.js (TypeScript) for the web app, packaged as a container image. The owner said not to spend effort on Docker; one Dockerfile exists only because Kubernetes needs an image to run.
- PostgreSQL for data. Phone sign-in is our own texted one-time codes.
- Photos go to S3-compatible storage (MinIO inside the cluster for local use).
- Stripe for card payments, saved cards, and refunds. Twilio for text messages.
- Every outside service (payments, texts, photo storage) sits behind a small interface with a fake version, so the whole app runs and its tests pass with no accounts or keys. Real keys switch on the real versions.
- Kubernetes (owner's decision): the web app as a Deployment with several copies, health checks, and autoscaling; the scheduler as a CronJob that assigns turns, sends reminders, and charges missed turns; Postgres and MinIO inside the cluster for local use; an Ingress; settings and secrets kept out of the image. Two setups: local (a cluster on a laptop) and production.
- CI (owner's decision): GitHub Actions that lint, type-check, run tests, build the image, and validate the Kubernetes files on every change, and publish the image on the main branch. Deploying to a real cluster is a manual, clearly marked step, because that needs the owner's cloud account.
- All money amounts stored as whole cents.
- Everything is built in one phase (owner's decision).

## Left to the builder

- Exact screens and visual design, phone-first.
- Database tables, as long as the ledger is append-only and balances are derived from it.
- Wording of text messages.
- Who may edit chores and prices once the house is running (default: anyone, with every change shown in the house activity feed).
- What happens to the rotation when someone joins or leaves mid-month.
- Time zone handling (default America/Toronto).
- Confirming current Stripe fees, refund time limits, and Twilio requirements for Canadian numbers at build time.
