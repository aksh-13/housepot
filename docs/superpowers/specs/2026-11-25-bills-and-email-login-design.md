# Housepot: bills, live simplified debts and email sign-in

Date: 2026-11-25. Status: approved by the owner on 2026-11-25, with one change (any housemate can edit or delete a bill).

Builds on the e-Transfer houses work (PR #1, merged). Read `2026-11-14-housepot-design.md` first for the chore rules and the ledger.

## Intent and why

The owner wants Housepot to be what a student house uses for all its shared money, not only chore penalties: "basically Splitwise, but even better", where everything "ties into a whole balance that you have".

Three things stand between the app as it is and a launch the owner wants today:

1. **There is no way to record a shared bill.** Groceries, internet and rent splits still need another app.
2. **Who owes whom is only worked out on settlement day.** Between settle-ups a housemate sees a score, not "you pay Sam $42".
3. **Nobody can sign in.** Sign-in is by text code, and Twilio needs days of verification before it can text Canadian numbers. The owner chose email codes instead.

Card payments (Stripe) stay off for this launch. The owner decided that.

## Goals

- Recording an equal split takes one screen: amount, what it was for, who paid, who shares it.
- A receipt can be split by what each person ordered, with tax and tip spread in proportion, without anyone doing arithmetic.
- Bills and chore penalties land in the same balance per person.
- The home screen always shows the fewest payments that would square the house up right now.
- People sign in with an email code. No text-message service is needed to run the app.
- No limits on how many bills a house records, and no ads. These are the main complaints about Splitwise's free plan.

## Non-goals (this version)

- Item-by-item receipts (typing every line and ticking who had it).
- Reading a receipt from a photo.
- Splitting by percentages or by shares.
- Repeating bills (rent every month).
- Bills in card houses.
- Several currencies. Everything is Canadian dollars.
- Automatic checking of Interac emails. The code stays, but it is switched off at launch (see Launch settings).
- Changing how early settle-up works. It stays a majority vote, as built.

## Anti-goals

- A bill must never make the ledger stop adding up. Every bill moves money between housemates only, and the entries for one bill always sum to zero.
- Deleting or editing a bill must never erase history. It is undone with opposite entries, and the activity feed says who did it.
- The receipt split must never lose or invent a cent. Shares always add up to exactly the total paid.
- A production deployment must never let anyone read sign-in codes or get free deposits (see Launch settings).

## Approaches considered

### Entering a receipt

1. **Per-person amounts (chosen by the owner).** Type the subtotal, the total paid, and what each person's own items came to. Anything left in the subtotal is shared equally. Fast on a phone, handles shared items, small build.
2. **Item by item.** Most precise, slow for long receipts, bigger build.
3. **Photo scan.** Nicest, needs a paid AI service, cannot be ready today.

Option 1 records the same thing the other two would (a share per person), so they can be added later without changing stored data.

### Sign-in without text messages

1. **Email code (chosen by the owner).** Reuses the existing code logic. e-Transfer already needs each person's email, and reminders can use it too.
2. **Google sign-in.** No codes, but gives no way to send reminders.
3. **Invite link, name and password.** No outside service, but no reminders and no password reset.

### Recording a bill in the ledger

One way fits: each sharer's share moves from their balance to the payer's balance, as ordinary ledger transfers. Keeping bills in a separate tally was rejected because the owner wants one balance, and settle-up already reads the ledger.

## How it works

### Bills

Available in e-Transfer houses only. Any active housemate can add one.

A bill has: a description (up to 60 characters), the total paid, who paid, who shares it, and how it is split. The payer must be an active housemate. The payer does not have to be one of the sharers. Sharers must be active housemates, at least one, and a bill where the only sharer is the payer is refused (it would move nothing). Total: at least $0.01, at most $10,000.

**Equal split.** The total is divided equally between the sharers. This is the default, with every active housemate ticked.

**Receipt split.** The person enters:

- the subtotal (before tax and tip),
- the total paid (after tax and tip),
- for each sharer, optionally, what their own items came to before tax.

Own items must not add up to more than the subtotal. What is left of the subtotal is the shared part, split equally between all the sharers. Each sharer's pre-tax amount is their own items plus their part of the shared part. Their share of the bill is the total paid multiplied by their pre-tax amount over the subtotal. The total may be lower than the subtotal (a discount); the same rule applies.

Example: subtotal $50.00, total $56.50. Sam's items $30, Priya's $20. Sam owes $33.90, Priya $22.60.

Example with a shared item: subtotal $60, total $67.80, three sharers. Sam's items $30, Priya's $10, nothing typed for Alex. Shared part $20, so $6.67 each before rounding. Pre-tax: Sam $36.67, Priya $16.67, Alex $6.67. Shares of $67.80 in proportion.

**Rounding.** Work in cents. Round every share down, then hand the leftover cents out one at a time: first to the payer if the payer is a sharer, then to the other sharers in rotation order. Shares always sum to the total.

**In the ledger.** For every sharer other than the payer, one transfer of their share from their balance to the payer's, with a new kind `expense`. The payer's own share moves nothing. A sharer whose share is zero cents gets no transfer.

**Editing and deleting.** Any active housemate can edit or delete any bill in their house (the owner's decision, as in Splitwise). Deleting writes opposite transfers (kind `expense_reversal`). Editing reverses the old transfers and writes new ones, in one database transaction. A bill added before the house's most recent settle-up is locked: it has already been turned into debts. Both show in the activity feed with who did it.

**Leaving.** Leaving already settles the whole house up, so a leaver's bills are covered by that. A bill cannot name someone who has left.

**Paused houses.** Bills can still be added while the house is paused. Pausing is about chores.

### Screens

**Add a bill** (new page, linked from the home screen with a prominent button):

```
Add a bill

What was it?      [ Groceries            ]
Total paid        [ $ 56.50 ]
Paid by           [ You ▾ ]

Split   (•) Equally   ( ) By receipt

Between  [x] You  [x] Sam  [x] Priya

--- only when "By receipt" is picked ---
Subtotal before tax  [ $ 50.00 ]
Own items   You [ 30.00 ]  Sam [ 20.00 ]  Priya [      ]
Shared between everyone ticked: $0.00

Each person pays
  You    $33.90
  Sam    $22.60

[ Add bill ]
```

The "each person pays" preview updates as the person types. The server works the shares out again itself and never trusts numbers from the browser.

**Home screen.** Keeps the one balance. Adds a "To square up" list: the fewest payments from the current balances, with the viewer's own lines first ("You pay Sam $42.10", "Priya pays you $8.00"). It uses the existing `minimalPayments` function on live balances. It is a preview: real debts are still only created by a settle-up. Money waiting on an unclaimed chore belongs to nobody yet, so it is left out and the list can add up to slightly less than the balances; say so in one small line when that happens.

**Bills list.** Recent bills for the house, newest first: description, total, who paid, the viewer's share, and edit and delete where allowed. Bills also appear in the activity feed.

### Email sign-in

Sign-in asks for an email address and emails a six-digit code. The limits stay as they are for texts: 10-minute codes, five attempts, a 30-second wait between sends, five sends an hour per address. Emails are lower-cased and trimmed before use.

A person is identified by their email. The phone number becomes optional and is not asked for. Every message the app sends (sign-in codes, turn reminders, bounty notices, debt notices) goes to the person's email through one sender. Messages keep their current wording; each needs a short subject line.

When someone creates or joins a house, their sign-in email is saved as their e-Transfer email straight away, so a settle-up always has somewhere to send money. They can change it in Settings. Housemates who owe them will see that address.

The operator page is opened by email address instead of phone number (`OPERATOR_EMAILS`).

Which way people sign in is a deployment setting (`SIGN_IN=email` or `phone`), default `phone` so existing tests and local setups keep working until they are moved over. The builder may instead move everything to email and drop phone sign-in if that is simpler; the owner does not need phone sign-in.

**Sending email.** One interface, three senders, picked by `EMAIL_PROVIDER`:

- `fake`: saved to the database and shown at the existing dev outbox page.
- `smtp`: any SMTP server. This is what works today with no domain, using a Gmail account and an app password (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`).
- `resend`: Resend's HTTPS API (`RESEND_API_KEY`, `EMAIL_FROM`), for when the owner has a domain.

Known constraint on hosting: Railway blocks outbound SMTP on its Hobby plan (Pro and above only). So `smtp` needs a host that allows it, or the owner needs a domain for `resend`. This is a deployment decision, not a build decision; both senders are built.

### Launch settings

With card payments off, a production deployment must set:

- `CARD_HOUSES=off` (new). The new-house page offers e-Transfer only, creating a card house is refused, and the pretend checkout page, the pay actions and the payments webhook all return not found (the pretend payment provider accepts unsigned events, so the webhook would otherwise let anyone credit a balance). Default `on`, so local development and tests are unchanged.
- `EMAIL_PROVIDER` to `smtp` or `resend`, never `fake`. The outbox page already returns not found when the sender is real; that check must cover the email sender too.
- `INBOUND_EMAIL_PROVIDER=off` (a new value; today only `fake` and `webhook` exist and unset means `fake`). The default stays `fake` so tests and local setups are unchanged, which means production must set `off` explicitly. With `off`: the pretend Interac pages and dev inbox return not found, the email webhook refuses everything, Settings hides the forwarding-address setup, and debt messages and the settle page drop the "send an Interac request to make it one tap" wording. People use the "I sent it" and "It arrived" buttons.

The production overlay in `k8s/overlays/prod` and the README's settings table and "Going live" section are updated to match all three.

### Existing data

The app has never been deployed, so there are no real users or houses to carry over. The migration makes `users.phone` optional and adds a unique email. No step links phone accounts to email accounts.

## Constraints

- All money rules live in `src/domain` as plain functions taking a database and a time, tested without the web layer. Tests are written first.
- Money is whole cents in integers everywhere.
- One migration file, `004_...sql`. Existing houses and users must keep working after it runs.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all pass, and CI stays green.
- The owner wants to deploy today. Keep the build to what is written here.

## Calls made by the designer, for the owner to check

- Nobody is emailed when a bill is added; it shows in the activity feed. Fewer emails, in line with the first design's rule against becoming a muted group chat.
- Early settle-up stays a majority vote.
- Bills are for e-Transfer houses only.
- Leftover cents go to the payer first.
- Bill limit of $10,000.
- Your sign-in email becomes your e-Transfer email automatically, visible to housemates who owe you.
- With Interac checking off, the forwarding-address setup is hidden rather than left in place unused.

## Left to the builder

- Table and column names, and how a bill's shares and its edit history are stored.
- How "added before the most recent settle-up" is detected.
- Whether the receipt preview is a small client component or a server round trip.
- The SMTP library.
- Page routes and styling, following the existing design system in `globals.css`.
- Whether phone sign-in is kept behind the setting or removed.
