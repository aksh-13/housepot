# Housepot: no skipping, agreed chore worth, approval votes and a first-run walkthrough

Status: plan, waiting on the owner's go-ahead. Nothing here is built yet.

## Intent and why

Housepot should make chores a consequence, not a purchase. Today a housemate can press "Skip for $5" and walk away, so the price works like a fee to hand the chore to someone else. The owner wants:

1. No skip button. The only way a chore costs you money is letting it expire.
2. When a chore expires, the first housemate (other than the person it expired on) who does it, with photo proof, takes the chore's worth. This is today's expire-and-claim rule, kept.
3. A chore's worth only matters when it expires, and the house has to agree on it.
4. Every finished chore needs photo proof (one or more photos), and a majority of the rest of the house votes to approve it before it counts.
5. A first-run walkthrough that tells each new person what setup needs and walks them through it.

## What changes

### 1. Skipping goes away

- Remove "Skip for $X" / "Pay $X to skip" from the House page and `payToSkip` from the actions.
- The chore's price is renamed **worth** everywhere a person sees it ("Garbage is worth $5"). The database column `skip_price_cents` stays as it is, so no data moves.
- Leaving the house with a turn waiting on you still charges that turn's worth, recorded as a miss rather than a skip.
- Old "skipped" entries stay in the activity feed as history.

### 2. Expiring and claiming (kept, one change)

- Deadline passes with no approved or pending proof: the assignee is charged the chore's worth and the chore opens to the house, as now. Team chores split the worth across the team, as now.
- **Change:** the person the chore expired on cannot claim it themselves. Today they can, which lets them get their own money back by doing it late, so being late costs nothing.
- The claimer's payout waits for approval (section 4).
- Unclaimed money still rolls over to the next on-time finisher of that chore.

### 3. Agreeing on what each chore is worth

- **During setup** the person creating the house sets the worth of every chore before anyone else joins. No vote is needed, because nobody else is in the house yet.
- **After someone else has joined**, a new chore, or a change to an existing chore's worth, is a **proposal**. It shows on the House page for everyone, and it takes effect once a majority of the other active housemates agree. Until then a new chore gets no turns, and an existing chore keeps its old worth.
- A proposal that does not get a majority within 3 days lapses. The person who proposed it can propose again.
- Editing a chore's name, day or deadline time does not need a vote. Only the worth does.
- Every proposal, vote and outcome shows in the activity feed.

### 4. Approval votes on finished chores (replaces disputes)

- "Done" and "Claim" both need at least one photo, up to 4.
- Submitting puts the chore in **waiting for approval**. Everyone else in the house gets a vote: "Looks done" or "Not done". Each voter sees the photos.
- **Approved** when more than half of the other active housemates say "Looks done". Then the turn counts as done and any money waiting on the chore is paid out.
- **Rejected** when more than half say "Not done". If the deadline has not passed, the person can submit new photos. If it has, the chore expires as if nothing was submitted. A rejected claim pays nothing, and the chore stays open.
- **Timing:** proof submitted before the deadline counts as on time, however long the vote takes.
- **Nobody votes:** after 48 hours with no majority either way, it counts as approved. (This is the owner's decision; see below.)
- In a one-person house there is nobody to vote, so it is approved at once.
- The 24-hour dispute system goes, because approval covers the same ground before money moves instead of after. The old tables stay for history.

### 5. First-run walkthrough

A short step-by-step screen the first time someone opens the app, with progress dots, one thing per screen and a skip-for-now link on optional steps.

- **Starting a house:**
  1. How Housepot works: chores rotate, photos prove it, the house votes, and a chore that expires is up for grabs.
  2. Name the house.
  3. Add your chores, each with a day, a deadline and its worth. At least one is required.
  4. Your e-Transfer email, so housemates can pay you.
  5. Invite housemates (share link).
- **Joining a house:**
  1. How it works (same screen).
  2. The house's chores and what each is worth, so you know what you are agreeing to.
  3. Your e-Transfer email.
- The walkthrough is remembered per person. It can be reopened from Settings ("How Housepot works").

### 6. Swapping turns

Chores rotate, so a turn is fixed once it is yours. A swap lets two people agree to move it.

- On a waiting turn, its owner taps **Ask someone to take it**, picks a housemate, and can offer one of that person's waiting turns in exchange.
- The other person accepts or declines. On accept, the turn is theirs (they are reminded, and an expiry is charged to them). An exchange moves both turns at once.
- Until they accept, the turn stays with its owner. A request lapses when either turn's deadline passes, or when either turn stops waiting.
- No money moves. One open request per turn. Team chores can already be handed to a teammate on the Teams tab, so swaps are for one-person turns.

### 7. Teams in setup

Teams already exist (the Teams tab), but setup never mentions them.

- The walkthrough asks **How does your house share chores?**: "Everyone takes turns" (the default; nothing else shown) or "Teams take turns on duty" (how many teams, and how many weeks each). Picking teams creates them.
- People can only be put on a team once they have joined, so while a house has teams and an active housemate on no team, the House page shows "Put people on teams" with a link to the Teams tab.
- Each chore added in a team house asks whether it is for the team on duty or one person at a time, as now.

## Built in this order

1. Skipping removed, and the "worth" wording. Small.
2. Multiple photos per submission: a new `turn_photos` table, with the existing single `photo_id` kept for old turns.
3. Approval votes replace disputes: new turn status `pending`, new `approval_votes` table, the tick closes votes after 48 hours, and the House page gets an "Approve" section.
4. The person a chore expired on cannot claim it.
5. Worth proposals: a `chore_proposals` table and `proposal_votes`, plus the House page section.
6. Swapping turns: a `swap_requests` table.
7. The first-run walkthrough, with the teams question: `members.onboarded_at`.
8. README and design-doc updates, tests for each step, then a browser walkthrough.

Each step is its own commit on `feat/approvals-and-chore-worth`, with tests passing at every commit.

## Not in this round

- **Item-by-item receipts, and reading a receipt from a photo.** See below. It is planned as the next round, after item-by-item entry exists.
- **Percentage splits.** Small, and can ride along with the receipt work.
- **Bills in card houses.** Card houses are switched off at launch, so this is skipped until they are switched back on.

## Reading receipts without an AI model

Deterministic and free is possible:

- **Turning the photo into text:** [Tesseract](https://github.com/tesseract-ocr/tesseract) is the standard open-source OCR engine, and `tesseract.js` runs it in the phone's browser. No server, no API key, no per-receipt cost. It is a trained character recogniser, not an LLM, and gives the same output for the same photo.
- **Turning the text into items:** plain rules. A line ending in a price (`2.99`) is an item. Lines starting `SUBTOTAL`, `HST`/`GST`/`TAX` and `TOTAL` are the summary. Check that the items add up to the subtotal, which tells you the read was good.
- **Honest limits:** crumpled or faded thermal paper reads badly, store abbreviations stay abbreviations ("GRT VAL 2% MLK"), and every store's layout differs. So the result pre-fills the item list for a person to check and fix, and never goes straight into a bill.
- **If accuracy is not good enough:** Google Cloud Vision OCR is better at reading (first 1,000 images a month free, then about $1.50 per 1,000). The rule-based parsing stays the same.

## Calls for the owner to check

- After 48 hours with no majority, a submission is **approved** (silence means yes). The alternative, "stays pending until a majority says yes", lets one inactive house block everyone's payouts.
- The person a chore expired on **cannot** claim it back.
- Worth changes, not just new chores, need a majority vote.
- A worth proposal lapses after 3 days.
- Up to 4 photos per submission.
- Disputes are removed, not kept alongside approval.
