# Bills, Live Simplified Debts and Email Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an e-Transfer house record shared bills (equal or by receipt with tax spread in proportion), see the fewest payments that square it up at any time, and sign in by email code, with settings that make a card-free production launch safe.

**Architecture:** A bill is stored in two new tables and applied to the existing double-entry ledger as one `expense` transfer per sharer to the payer, so balances and settle-up need no changes. The split arithmetic is a pure function. Email sign-in reuses the one-time-code logic with an address that is either a phone number or an email, and every notification goes through the existing `Sms` interface, which gains email senders.

**Tech Stack:** Next.js 15 (app router, server actions), TypeScript, Postgres via `pg`, Vitest against a real Postgres, Biome, pnpm. New dependency: `nodemailer`.

**Spec:** `docs/superpowers/specs/2026-11-25-bills-and-email-login-design.md`. Read it, and `docs/superpowers/specs/2026-11-14-housepot-design.md` for the ledger.

## Global Constraints

- Money is whole cents in integers everywhere. Never floats for stored or compared amounts.
- All money rules live in `src/domain` as plain functions taking a `Db` and a `now: Date`, tested without the web layer. Write the test first.
- The entries for one bill always sum to zero and only touch member accounts.
- Deleting or editing a bill never deletes ledger rows; it writes opposite transfers.
- Bill total: 1 to 1,000,000 cents ($0.01 to $10,000). Description: 1 to 60 characters after trimming.
- Bills exist only in houses with `moneyMode === "etransfer"`.
- One migration file for the whole plan: `migrations/004_bills_and_email.sql`, written in full in Task 2.
- Defaults keep today's behaviour: `SIGN_IN=phone`, `CARD_HOUSES=on`, `INBOUND_EMAIL_PROVIDER=fake`, `EMAIL_PROVIDER=fake`. The existing 226 tests must pass unchanged except where a task says otherwise.
- After every task: `pnpm lint && pnpm typecheck && pnpm test` pass. Tests need `pnpm db:up` (Docker).
- User-facing copy is plain and short, in the voice of the existing screens. No new CSS framework; use the classes in `src/app/globals.css`.
- Commit after each task with a conventional message (`feat:`, `fix:`, `docs:`), matching `git log`.

## Review Focus

Inputs and conditions the spec implies but does not spell out. Each has a test in the task named.

1. Money typed loosely: `12.5`, `$1,200.50`, ` 7 `, `abc`, `-3`, `1.999`. Expected: the first three parse, the rest are refused with a clear message, never `NaN` in the ledger. (Task 3)
2. The add-bill form submitted twice (double tap, back and resubmit). Expected: one bill. (Task 4)
3. A settle-up or a housemate leaving between opening the edit form and saving it. Expected: the edit is refused with a clear message and the ledger is unchanged. (Task 4)
4. The same email typed with different capitals or spaces. Expected: one account. (Task 2)
5. The email sender failing while sending a sign-in code. Expected: the person sees "Could not send the code", not an error page. (Task 2)

## File Structure

| File | Responsibility |
| --- | --- |
| `src/settings.ts` (new) | Reads deployment settings: `cardHousesOn()`, `inboundMode()`, `signInBy()`, `emailProvider()`. No imports from the app. |
| `migrations/004_bills_and_email.sql` (new) | Email on users, generic one-time-code address, bills tables, `houses.last_settled_at`. |
| `src/providers/email.ts` (new) | `smtpEmail`, `resendEmail`, `subjectFor`. Both senders implement the existing `Sms` interface. |
| `src/domain/split.ts` (new) | `splitBill` and `parseDollars`. Pure, no database. |
| `src/domain/bills.ts` (new) | `createBill`, `editBill`, `deleteBill`, `houseBills`, `billById`. |
| `src/domain/settleup.ts` | Gains `houseSquareUp`; `settleUpHouse` stamps `last_settled_at`. |
| `src/app/bills/page.tsx`, `src/app/bills/new/page.tsx`, `src/app/bills/[id]/page.tsx` (new) | Bills list, add form, edit form. |
| `src/components/bill-form.tsx` (new) | Client component: the form fields and the live "each person pays" preview. |
| `test/settings.test.ts`, `test/email.test.ts`, `test/split.test.ts`, `test/bills.test.ts` (new) | One test file per new module. |

---

### Task 1: Launch settings (card houses off, Interac checking off)

**Files:**
- Create: `src/settings.ts`, `test/settings.test.ts`
- Modify: `src/providers/index.ts` (`inboundIsFake`), `src/domain/houses.ts` (`createHouse`), `src/domain/settleup.ts` (`textNewDebts` wording, about line 324), `src/app/new/page.tsx`, `src/app/dev/fake-checkout/page.tsx`, `src/app/actions.ts` (`payAction`, `fakePayAction`), `src/app/api/webhooks/payments/route.ts`, `src/app/api/webhooks/email/route.ts`, `src/app/house/settings/page.tsx` (forwarding block, about lines 100-130), `src/app/settle/page.tsx` (about lines 110-140)
- Modify: `.env.example`, `k8s/overlays/prod/kustomization.yaml`, `README.md` (Settings table)
- Test: `test/settings.test.ts`, `test/houses.test.ts`, `test/routes.test.ts`, `test/settleup.test.ts`

**Interfaces:**
- Produces, in `src/settings.ts`:
  - `cardHousesOn(): boolean` — `CARD_HOUSES`, values `on` | `off`, default `on`.
  - `inboundMode(): "fake" | "webhook" | "off"` — `INBOUND_EMAIL_PROVIDER`, default `fake`.
  - `signInBy(): "phone" | "email"` — `SIGN_IN`, default `phone`.
  - `emailProvider(): "fake" | "smtp" | "resend"` — `EMAIL_PROVIDER`, default `fake`.
  - Each throws `Error` naming the variable and allowed values on any other value (same wording as `oneOf` in `src/providers/index.ts`).

- [ ] **Step 1: Write failing tests in `test/settings.test.ts`**

For each of the four functions: returns the default when the variable is unset, returns each allowed value, throws on `"offf"`. Save and restore `process.env` in `beforeEach`/`afterEach`.

- [ ] **Step 2: Write failing behaviour tests**

```ts
// test/houses.test.ts
test("a card house cannot be created when card houses are off", async () => {
  process.env.CARD_HOUSES = "off";
  const r = await createHouse(db, { userId: await makeUser("Ana"), houseName: "H", moneyMode: "card", now });
  expect(r).toEqual({ ok: false, error: "Card houses are switched off." });
});
test("an e-Transfer house can still be created when card houses are off", ...); // r.ok === true

// test/routes.test.ts
test("the payments webhook answers 404 when card houses are off, and credits nothing", ...);
// POST a valid fake event with x-fake-signature: fake; expect status 404 and memberBalance === 0
test("the email webhook answers 404 when Interac checking is off", ...);
// INBOUND_EMAIL_PROVIDER=off, correct bearer secret, valid body; expect 404

// test/settleup.test.ts
test("with Interac checking off, the settle-up text does not mention an Interac request", ...);
// run settleUpHouse + textNewDebts with INBOUND_EMAIL_PROVIDER=off; no outbox body matches /Interac request/i
```

Reset `CARD_HOUSES` and `INBOUND_EMAIL_PROVIDER` in `afterEach` in each file touched.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm test test/settings.test.ts test/houses.test.ts test/routes.test.ts test/settleup.test.ts`
Expected: the new tests fail (module not found, wrong status, wrong result).

- [ ] **Step 4: Implement**

- `src/settings.ts` as in Interfaces.
- `inboundIsFake()` becomes `inboundMode() === "fake"`. Add and export `inboundIsOff = () => inboundMode() === "off"` beside it.
- `createHouse`: refuse `moneyMode === "card"` when `!cardHousesOn()` with the exact error above.
- `/new`: when card houses are off, render no money-mode radios and no deposit select; submit a hidden `moneyMode=etransfer`.
- `fake-checkout` page, `payAction`, `fakePayAction`: `notFound()` when card houses are off.
- Payments webhook: `return new Response("not found", { status: 404 })` before parsing when card houses are off.
- Email webhook: 404 when `inboundMode() === "off"`.
- Settings page: hide the whole forwarding-address block (address, Gmail/Outlook steps, confirmation code, recent inbound emails) when off.
- Settle page: when off, hide the "Make it one tap for them" paragraph and the request-reached line; the copy-email, code, open-bank, "I sent it" and "It arrived" controls stay.
- `textNewDebts`: when off, the receiver's text is `Housepot settle-up: ${d.fromName} owes you ${amount}. ${link}`.

- [ ] **Step 5: Config and docs**

- `.env.example`: add `CARD_HOUSES=on`, document `INBOUND_EMAIL_PROVIDER` values `fake | webhook | off`.
- `k8s/overlays/prod/kustomization.yaml` config literals: `CARD_HOUSES=off`, `INBOUND_EMAIL_PROVIDER=off`, `PAYMENTS_PROVIDER=fake`; remove `SMS_PROVIDER=twilio`. Remove the Stripe and Twilio lines from `k8s/overlays/prod/secret.env.example`.
- README Settings table: add both variables.

- [ ] **Step 6: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && kubectl kustomize k8s/overlays/prod > /dev/null`
Expected: all pass.

```bash
git add -A && git commit -m "feat: launch settings to switch off card houses and Interac checking"
```

---

### Task 2: Email sign-in and email as the way to reach people

**Files:**
- Create: `migrations/004_bills_and_email.sql`, `src/providers/email.ts`, `test/email.test.ts`
- Modify: `src/domain/auth.ts`, `src/domain/houses.ts`, `src/domain/settleup.ts`, `src/domain/settlement.ts`, `src/domain/tick.ts`, `src/domain/views.ts`, `src/providers/index.ts`, `src/lib/operator.ts`, `src/app/actions.ts`, `src/app/login/page.tsx`, `src/app/operator/page.tsx`, `src/app/house/settings/page.tsx`, `src/app/dev/outbox/page.tsx`, `test/helpers.ts`
- Modify: `package.json` (add `nodemailer`, `@types/nodemailer`), `.env.example`, `k8s/overlays/prod/kustomization.yaml`, `k8s/overlays/prod/secret.env.example`, `README.md`
- Test: `test/auth.test.ts`, `test/email.test.ts`, `test/houses.test.ts`

**Interfaces:**
- Consumes: `signInBy()`, `emailProvider()` from Task 1.
- Produces:
  - `User = { id: string; phone: string | null; email: string | null; name: string | null }` in `src/domain/auth.ts`.
  - `requestCode(db, sms, address, now)` and `verifyCode(db, address, code, now)` — `address` is a normalized phone (`+1...`) or a normalized email. Same return types as today.
  - `Member.contact: string` replaces `Member.phone` (`coalesce(u.email, u.phone)`). `DebtView.fromContact` / `toContact` replace `fromPhone` / `toPhone`.
  - `isOperator(user: { phone: string | null; email: string | null }): boolean`.
  - In `src/providers/email.ts`: `subjectFor(body: string): string`, `smtpEmail(env: { SMTP_HOST; SMTP_PORT; SMTP_USER; SMTP_PASS; EMAIL_FROM }): Sms`, `resendEmail(env: { RESEND_API_KEY; EMAIL_FROM }, fetchFn = fetch): Sms`.
  - `makeUser(name: string, opts?: { email?: string }): Promise<string>` in `test/helpers.ts`.

- [ ] **Step 1: Write the whole migration**

`migrations/004_bills_and_email.sql`. Tasks 4 and 5 rely on these exact names:

```sql
-- Signing in by email. A person has a phone number, an email, or both.
alter table users alter column phone drop not null;
alter table users add column email text unique;
alter table users add constraint users_reachable check (phone is not null or email is not null);
-- One-time codes go to a phone number or an email address.
alter table otp_codes rename column phone to address;

-- Bills are locked once a settle-up has turned them into debts.
alter table houses add column last_settled_at timestamptz;

-- A shared bill. The money itself lives in the ledger; these tables say what the bill was.
create table bills (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  description text not null,
  total_cents int not null check (total_cents between 1 and 1000000),
  -- Set for a receipt split (the amount before tax and tip). Null for an equal split.
  subtotal_cents int check (subtotal_cents between 1 and 1000000),
  paid_by_member_id uuid not null references members(id),
  created_by_member_id uuid not null references members(id),
  -- Goes up by one on every edit. Part of each ledger ref, so an edit can be told from the original.
  revision int not null default 1,
  -- Sent by the form so a double submit makes one bill.
  client_token text unique,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);
create index bills_house on bills (house_id, created_at desc);

create table bill_shares (
  bill_id uuid not null references bills(id) on delete cascade,
  member_id uuid not null references members(id),
  -- Receipt splits only: what this person's own items came to before tax. Null when nothing was typed.
  own_cents int check (own_cents >= 0),
  share_cents int not null check (share_cents >= 0),
  primary key (bill_id, member_id)
);
```

- [ ] **Step 2: Write failing tests**

```ts
// test/auth.test.ts (new tests; existing phone tests stay)
test("an email code signs a person in and creates them with that email", ...);
// requestCode(db, sms, "ana@example.com", now) ok; read the code from sms_outbox;
// verifyCode returns a session; users row has email 'ana@example.com' and phone null
test("the same email in different capitals is one account", ...);
// sign in as "Ana@Example.com " then "ana@example.com" via normalizeEmail: one users row
test("an email is not checked against the allowed phone prefixes", ...);
test("when the sender fails, asking for a code reports it instead of throwing", async () => {
  const broken = { send: async () => { throw new Error("smtp down"); } };
  expect(await requestCode(db, broken, "ana@example.com", now)).toEqual({
    ok: false, error: "Could not send the code. Try again in a minute.",
  });
});

// test/email.test.ts
test("subjectFor takes the first sentence", () => {
  expect(subjectFor("Your Housepot code is 123456. It works for 10 minutes."))
    .toBe("Housepot: Your Housepot code is 123456");
});
test("subjectFor cuts a long first sentence at 60 characters", ...); // result.length <= "Housepot: ".length + 60
test("resendEmail posts to Resend with the key, from, to, subject and text", ...);
// pass a fake fetch; expect URL https://api.resend.com/emails, Authorization "Bearer k",
// JSON body { from, to: [to], subject: subjectFor(body), text: body }
test("resendEmail throws when Resend refuses", ...); // fake fetch returns status 422

// test/houses.test.ts
test("joining an e-Transfer house saves the sign-in email as the e-Transfer email", ...);
// makeUser("Ana", { email: "ana@example.com" }); createHouse etransfer; memberForUser(...).etransferEmail === "ana@example.com"
test("a member's contact is their email when they have one, otherwise their phone", ...);
```

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm test test/auth.test.ts test/email.test.ts test/houses.test.ts`
Expected: new tests fail.

- [ ] **Step 4: Implement the domain side**

- `auth.ts`: rename the parameter and the `otp_codes` column use to `address`. The prefix check runs only when `address` starts with `+`. Wrap `sms.send` in try/catch and return the error above. `verifyCode` upserts `users` on `email` when the address contains `@`, otherwise on `phone`. `sessionUser` selects `email` too. `hashCode` is unchanged (it already mixes the address in).
- Reuse `normalizeEmail` from `src/domain/houses.ts`.
- `houses.ts`: `MEMBER_COLUMNS` selects `coalesce(u.email, u.phone) as contact` instead of `u.phone`. `addMember` sets `etransfer_email` to the user's email in an e-Transfer house.
- Replace every `.phone` / `fromPhone` / `toPhone` / `from_phone` used as a message destination with the contact equivalent: `src/domain/tick.ts`, `src/domain/views.ts`, `src/domain/settleup.ts`, `src/domain/settlement.ts`, `src/app/actions.ts`, `src/app/operator/page.tsx`, `src/app/house/settings/page.tsx`. `grep -rn "phone" src` afterwards should show only `auth.ts`, `normalizePhone` callers, `operator.ts` and comments.
- `operator.ts`: operator when the user's email is in `OPERATOR_EMAILS` (lower-cased, comma-separated) or their phone is in `OPERATOR_PHONES`.
- `test/helpers.ts`: `makeUser` takes the optional email. `TestMember.phone` stays.

- [ ] **Step 5: Implement the senders and provider choice**

- `pnpm add nodemailer && pnpm add -D @types/nodemailer`.
- `src/providers/email.ts`: `subjectFor` returns `"Housepot: "` plus the body up to the first `. ` or `: `, cut to 60 characters. `smtpEmail` uses nodemailer (`secure: true` when the port is 465). `resendEmail` uses `fetch`; non-2xx throws `Error` with the status and response text.
- `src/providers/index.ts`: when `signInBy() === "email"`, the `sms` provider is chosen by `emailProvider()` (`fake` keeps `fakeSms`); otherwise today's logic. `smsIsFake()` follows the same rule. Add the mode and provider to the cache key. Use the existing `need()` for required variables.
- Add `nodemailer` to `serverExternalPackages` in `next.config.mjs`.

- [ ] **Step 6: Implement the screens**

- `/login`: when `signInBy() === "email"`, the first step asks for "Email" (`type="email"`, `autoComplete="email"`), the button reads "Email me a code", and step two reads "We emailed a 6-digit code to …". Rename the query parameter and hidden field from `phone` to `to`. Phone mode keeps today's copy.
- `requestCodeAction` / `verifyCodeAction`: normalize with `normalizeEmail` or `normalizePhone` by mode; the bad-input message is "That does not look like an email address." in email mode.
- `/dev/outbox`: heading "Message outbox", and the note says messages are switched off without naming a variable.

- [ ] **Step 7: Config and docs**

- `.env.example`: `SIGN_IN`, `EMAIL_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `RESEND_API_KEY`, `EMAIL_FROM`, `OPERATOR_EMAILS`, each with a one-line comment. Note that Gmail needs an app password and that Railway's Hobby plan blocks SMTP.
- Prod overlay: `SIGN_IN=email`, `EMAIL_PROVIDER=resend` in config; `RESEND_API_KEY`, `EMAIL_FROM`, `OPERATOR_EMAILS` in `secret.env.example`.
- README: Settings table rows, and replace the Twilio step in "Going live" with email.

- [ ] **Step 8: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all pass.

```bash
git add -A && git commit -m "feat: sign in by email code and send every message by email"
```

---

### Task 3: Split arithmetic

**Files:**
- Create: `src/domain/split.ts`, `test/split.test.ts`

**Interfaces:**
- Produces:

```ts
export type SplitInput = {
  totalCents: number;
  payerId: string;
  /** In rotation order. */
  sharerIds: string[];
  /** Present for a receipt split. ownCents holds only the sharers something was typed for. */
  receipt?: { subtotalCents: number; ownCents: Record<string, number> };
};
export type Share = { memberId: string; cents: number };
export function splitBill(i: SplitInput): { ok: true; shares: Share[] } | { ok: false; error: string };
/** "12.5", "$1,200.50", " 7 " -> cents. Anything else -> null. */
export function parseDollars(input: string): number | null;
export const MAX_BILL_CENTS = 1_000_000;
```

`shares` has one entry per sharer, in `sharerIds` order, and always sums to `totalCents`.

- [ ] **Step 1: Write the failing tests in `test/split.test.ts`**

```ts
const split = (i: SplitInput) => {
  const r = splitBill(i);
  if (!r.ok) throw new Error(r.error);
  return Object.fromEntries(r.shares.map((s) => [s.memberId, s.cents]));
};

test("an equal split gives the leftover cent to the payer", () => {
  expect(split({ totalCents: 1000, payerId: "a", sharerIds: ["a", "b", "c"] })).toEqual({ a: 334, b: 333, c: 333 });
});
test("when the payer is not sharing, leftover cents go in rotation order", () => {
  expect(split({ totalCents: 1000, payerId: "z", sharerIds: ["a", "b", "c"] })).toEqual({ a: 334, b: 333, c: 333 });
});
test("a receipt spreads tax in proportion to what each person ordered", () => {
  expect(split({ totalCents: 5650, payerId: "sam", sharerIds: ["sam", "priya"],
    receipt: { subtotalCents: 5000, ownCents: { sam: 3000, priya: 2000 } } })).toEqual({ sam: 3390, priya: 2260 });
});
test("what is left of the subtotal is shared equally before tax is spread", () => {
  expect(split({ totalCents: 6780, payerId: "sam", sharerIds: ["sam", "priya", "alex"],
    receipt: { subtotalCents: 6000, ownCents: { sam: 3000, priya: 1000 } } })).toEqual({ sam: 4144, priya: 1883, alex: 753 });
});
test("a total below the subtotal (a discount) uses the same rule", ...); // total 4500, subtotal 5000, own 3000/2000 -> 2700/1800
test("shares always add up to the total", () => {
  // loop totals 1..300 and sharer counts 1..5 with a payer outside the split; sum(shares) === total
});
```

Refusals, each asserting the exact `error`:

| Input | Error |
| --- | --- |
| total `0`, `-5`, `1.5`, `1_000_001` | `The total must be between $0.01 and $10,000.` |
| no sharers | `Pick at least one person to share it.` |
| a sharer listed twice | `Each person can only be picked once.` |
| only sharer is the payer | `A bill only you share moves no money.` |
| subtotal `0` or over the limit | `The subtotal must be between $0.01 and $10,000.` |
| an own amount negative or not a whole number | `Each person's items must be $0 or more.` |
| an own amount for someone who is not a sharer | `Items were entered for someone who is not sharing the bill.` |
| own amounts add up to more than the subtotal | `The items add up to more than the subtotal.` |

`parseDollars`: `"12.5"` → 1250, `"$1,200.50"` → 120050, `" 7 "` → 700, `"0.01"` → 1; `"abc"`, `""`, `"-3"`, `"1.999"`, `"1e3"` → null.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm test test/split.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `splitBill` and `parseDollars`**

Integer arithmetic only. An equal split is a receipt split where nobody typed anything, so one code path serves both:

```ts
const n = sharerIds.length;
const subtotal = receipt?.subtotalCents ?? totalCents;
const own = (id: string) => receipt?.ownCents[id] ?? 0;
const shared = subtotal - sum(sharerIds.map(own));       // refused above if negative
// Each person's pre-tax amount, in units of 1/n of a cent, so the shared part divides exactly.
const weight = (id: string) => own(id) * n + shared;      // weights sum to subtotal * n
const cents = sharerIds.map((id) => Math.floor((totalCents * weight(id)) / (subtotal * n)));
// Hand out what rounding down left over, one cent each: the payer first if sharing, then rotation order.
```

`parseDollars` accepts an optional leading `$`, digits with optional commas, and at most two decimals.

- [ ] **Step 4: Run and see them pass**

Run: `pnpm test test/split.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/split.ts test/split.test.ts && git commit -m "feat: bill split arithmetic with tax spread in proportion"
```

---

### Task 4: Bills in the ledger

**Files:**
- Create: `src/domain/bills.ts`, `test/bills.test.ts`
- Modify: `src/domain/ledger.ts` (`TransferKind` gains `"expense"` and `"expense_reversal"`), `src/domain/settleup.ts` (`settleUpHouse` sets `houses.last_settled_at = a.now` inside its transaction)
- Test: `test/bills.test.ts`, `test/settleup.test.ts`

**Interfaces:**
- Consumes: `splitBill`, `SplitInput` (Task 3); tables from the Task 2 migration; `transfer`, `memberBalance`, `activeMembers`, `getHouse`, `logActivity`.
- Produces:

```ts
export type BillInput = {
  description: string;
  totalCents: number;
  paidByMemberId: string;
  sharerMemberIds: string[];
  receipt?: { subtotalCents: number; ownCents: Record<string, number> };
};
export type BillView = {
  id: string; houseId: string; description: string;
  totalCents: number; subtotalCents: number | null;
  paidByMemberId: string; paidByName: string; createdByName: string;
  createdAt: Date; edited: boolean;
  /** True once a settle-up has happened since the bill was added. */
  locked: boolean;
  shares: { memberId: string; name: string; ownCents: number | null; shareCents: number }[];
};
type Fail = { ok: false; error: string };
export function createBill(db: Db, a: { houseId: string; actorMemberId: string; input: BillInput; clientToken?: string; now: Date }): Promise<{ ok: true; billId: string } | Fail>;
export function editBill(db: Db, a: { billId: string; actorMemberId: string; input: BillInput; now: Date }): Promise<{ ok: true } | Fail>;
export function deleteBill(db: Db, a: { billId: string; actorMemberId: string; now: Date }): Promise<{ ok: true } | Fail>;
/** Not-deleted bills, newest first. */
export function houseBills(db: Db, houseId: string, limit?: number): Promise<BillView[]>;
export function billById(db: Db, billId: string): Promise<BillView | null>;
```

- [ ] **Step 1: Write the failing tests in `test/bills.test.ts`**

Use `makeHouse(3, { moneyMode: "etransfer" })`; members are `[ana, ben, cy]` in rotation order. Helper `bal = (m) => memberBalance(db, m.memberId)`.

```ts
test("an equal bill moves each other sharer's part to the payer", async () => {
  // ana pays 9000 for all three
  // balances: ana +6000, ben -3000, cy -3000; sum 0
});
test("a receipt bill charges each person their items plus their part of the tax", ...);
// ana pays 6780, subtotal 6000, own ana 3000 ben 1000 -> ana +2636, ben -1883, cy -753
test("the payer does not have to be a sharer", ...);       // ana pays 1000 for ben and cy: +1000, -500, -500
test("adding a bill shows in the activity feed", ...);     // kind "bill_added", data { description, totalCents, billId }
test("the same form token makes one bill", async () => {
  // createBill twice with clientToken "t1"; both ok with the same billId; one bills row; ben's balance moved once
});
test("deleting a bill puts every balance back and keeps the ledger rows", ...);
// balances all 0; transfers of kind 'expense_reversal' exist; the bill is gone from houseBills; activity "bill_deleted"
test("editing a bill replaces its effect on balances", ...);
// 9000 three ways, edited to 6000 between ana and ben only: ana +3000, ben -3000, cy 0; BillView.edited true; activity "bill_edited"
test("any active housemate can edit or delete a bill they did not add", ...);
test("a bill added before a settle-up is locked", async () => {
  // createBill; settleUpHouse(db, { houseId, now: later, reason: "early" });
  // editBill and deleteBill both return { ok: false, error: "This bill was already settled up, so it cannot be changed." }
  // billById(...).locked === true; balances unchanged by the refused calls
});
test("a bill added after a settle-up is not locked", ...);
test("an edit that names someone who has left is refused and changes nothing", ...);
// mark cy 'left' directly in the table; editBill with cy as sharer -> { ok: false, error: "Everyone on a bill must be an active housemate." }
```

Refusals, each asserting the exact `error` and that no `bills` row or transfer was written:

| Case | Error |
| --- | --- |
| house is a card house | `Bills are for houses that settle up by e-Transfer.` |
| actor is not an active member of the house | `Only housemates can add bills.` |
| payer or a sharer is not an active member of this house | `Everyone on a bill must be an active housemate.` |
| description empty after trimming | `Say what the bill was for.` |
| any `splitBill` refusal | that function's error, unchanged |
| bill id unknown, deleted, or in another house than the actor's | `That bill does not exist.` |

Add to `test/settleup.test.ts`: `settleUpHouse` sets `houses.last_settled_at` to `now`.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm test test/bills.test.ts test/settleup.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/domain/bills.ts`**

- Every write runs in `db.tx` and first takes `select pg_advisory_xact_lock(hashtext($1))` with `house:${houseId}`, the same lock `settleUpHouse` takes, so a settle-up cannot land in the middle.
- Sharers are passed to `splitBill` in rotation order (order from `activeMembers`), whatever order the caller gave.
- Description is trimmed and cut to 60 characters.
- For each sharer other than the payer with a share above zero: `transfer` from the sharer to the payer, kind `expense`, ref `bill:${billId}:${revision}:${memberId}`.
- Undoing a revision: for each `bill_shares` row with a share above zero whose member is not the payer, `transfer` from the payer to the sharer, kind `expense_reversal`, ref `bill:${billId}:${revision}:${memberId}:undo`.
- `editBill`: undo the current revision, replace the `bill_shares` rows, set the new fields, `revision + 1`, `updated_at = now`, then apply the new revision.
- `deleteBill`: undo, set `deleted_at = now`.
- `locked` is `houses.last_settled_at is not null and bills.created_at <= houses.last_settled_at`. `edited` is `revision > 1`.
- `createBill` with a `clientToken` that already exists returns the existing bill's id and writes nothing.
- Activity kinds `bill_added`, `bill_edited`, `bill_deleted`, each with `memberId` set to the actor and `data: { billId, description, totalCents }`.

- [ ] **Step 4: Run and see them pass**

Run: `pnpm test test/bills.test.ts test/settleup.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add -A && git commit -m "feat: shared bills recorded in the ledger, with edit, delete and locking after settle-up"
```

---

### Task 5: "To square up" on the home screen

**Files:**
- Modify: `src/domain/settleup.ts`, `src/app/house/page.tsx`
- Test: `test/settleup.test.ts`

**Interfaces:**
- Consumes: `minimalPayments`, `Payment` (existing, `src/domain/settleup.ts`); `createBill` (Task 4) in tests.
- Produces:

```ts
export type SquareUpLine = Payment & { fromName: string; toName: string };
/** The fewest payments that would square the house up right now. Creates nothing. */
export function houseSquareUp(db: Db, houseId: string): Promise<{ lines: SquareUpLine[]; unclaimedCents: number }>;
```

`unclaimedCents` is the total sitting on the house's chores (bounties nobody has claimed).

- [ ] **Step 1: Write the failing tests**

```ts
test("square-up turns bills into the fewest payments", async () => {
  // etransfer house of 3; ana pays 9000 for all; ben pays 3000 for all
  // balances: ana +5000, ben -1000, cy -4000 -> lines: cy pays ana 4000, ben pays ana 1000 (in that order)
  // unclaimedCents 0
});
test("square-up creates no debts and moves no money", ...); // debts table empty, balances unchanged after the call
test("square-up reports money still waiting on a chore", ...);
// one skipped turn with a $5 bounty open -> unclaimedCents 500, and the lines add up to less than the debtor's balance
test("square-up of an even house is empty", ...);
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm test test/settleup.test.ts`
Expected: FAIL, `houseSquareUp` is not exported.

- [ ] **Step 3: Implement `houseSquareUp`**

Balances for members with `status <> 'left'` (the same query `settleUpHouse` uses), passed to `minimalPayments`, with names joined on.

- [ ] **Step 4: Add the section to the home screen**

In `src/app/house/page.tsx`, for e-Transfer houses only, add a section labelled "To square up" directly above "The pot":

- The viewer's own lines first: "You pay Sam $42.10", "Priya pays you $8".
- Then the rest: "Ben pays Sam $5".
- Empty: "Everyone is square."
- When `unclaimedCents > 0`, one small muted line: "$5 is waiting on unclaimed chores and is not counted here."
- Below the list, a small muted line: "These become real payments at the next settle-up on {dateLabel(house.settlementDate)}."

Use `formatCents` and the existing `section`, `label`, `muted`, `small` classes.

- [ ] **Step 5: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add -A && git commit -m "feat: show the fewest payments that square the house up, live"
```

---

### Task 6: Bills screens

**Files:**
- Create: `src/app/bills/page.tsx`, `src/app/bills/new/page.tsx`, `src/app/bills/[id]/page.tsx`, `src/components/bill-form.tsx`
- Modify: `src/app/actions.ts`, `src/app/house/page.tsx` (button and activity lines), `src/components/frame.tsx` (a "Bills" tab for e-Transfer houses), `src/app/globals.css` (only if an existing class does not fit)
- Test: `test/bills.test.ts` (form parsing)

**Interfaces:**
- Consumes: `createBill`, `editBill`, `deleteBill`, `houseBills`, `billById`, `BillInput`, `BillView` (Task 4); `splitBill`, `parseDollars` (Task 3); `requireMember`, `activeMembers`.
- Produces:
  - `billInputFromForm(fd: FormData): { ok: true; input: BillInput } | { ok: false; error: string }` exported from `src/domain/bills.ts`.
  - Server actions `addBillAction(fd)`, `editBillAction(fd)`, `deleteBillAction(fd)` in `src/app/actions.ts`.

Form field names (the component and `billInputFromForm` must agree): `description`, `total`, `paidBy` (member id), `split` (`equal` | `receipt`), `sharer` (repeated, member ids), `subtotal`, `own:<memberId>`, `token`, and for edits `billId`.

- [ ] **Step 1: Write failing tests for `billInputFromForm`**

```ts
test("an equal form becomes a bill input", ...);
// description "Groceries", total "56.50", paidBy a, split equal, sharer a + b
// -> { description: "Groceries", totalCents: 5650, paidByMemberId: a, sharerMemberIds: [a, b] } with no receipt
test("a receipt form carries the subtotal and only the items that were typed", ...);
// own:a "30", own:b "" -> receipt { subtotalCents: 5000, ownCents: { [a]: 3000 } }
test("subtotal and own amounts are ignored when the split is equal", ...);
test("money that does not parse is refused with the field named", ...);
// total "abc" -> "The total is not an amount of money."
// subtotal "x" on a receipt -> "The subtotal is not an amount of money."
// own:a "1.999" -> "One of the item amounts is not an amount of money."
```

- [ ] **Step 2: Run and see them fail, then implement `billInputFromForm`**

Run: `pnpm test test/bills.test.ts`

- [ ] **Step 3: Implement the actions**

Each calls `requireMember`, builds the input with `billInputFromForm`, calls the domain function, and uses the file's existing `back()` helper:

- `addBillAction`: on failure back to `/bills/new` with the error; on success back to `/bills` with notice "Bill added." Passes the hidden `token` as `clientToken`.
- `editBillAction`: failure back to `/bills/<id>`; success to `/bills` with "Bill updated."
- `deleteBillAction`: to `/bills` with "Bill deleted." or the error.
- All three `notFound()` when the house is not an e-Transfer house.

- [ ] **Step 4: Implement the form component**

`src/components/bill-form.tsx`, a client component, props `{ members: { id: string; name: string }[]; meId: string; bill?: BillView; action: (fd: FormData) => Promise<void>; token: string }`. Layout as in the spec's "Add a bill" sketch.

- Defaults for a new bill: paid by the viewer, split equally, every member ticked.
- The receipt fields show only when "By receipt" is picked. Own-item inputs show only for ticked members.
- A line "Shared between everyone ticked: $X" under the own-item inputs.
- "Each person pays" preview: call `splitBill` in the browser with the current values (it is pure and imports nothing from the server). Show the shares when it succeeds, its error in muted text when it fails and a total has been typed.
- Money inputs use `inputMode="decimal"`.
- Submit with the existing `SubmitButton` ("Add bill" / "Save changes").

The server never trusts the preview: the actions recompute through `createBill` / `editBill`.

- [ ] **Step 5: Implement the pages**

- `/bills/new`: `requireMember("/bills/new")`, `notFound()` for card houses, renders the form with a fresh `crypto.randomUUID()` token.
- `/bills/[id]`: loads `billById`; `notFound()` if missing or from another house. A locked bill shows its details read-only with "Settled up, so it cannot be changed." Otherwise the form prefilled, plus a separate delete form with a "Delete bill" button.
- `/bills`: `houseBills`, newest first. Each row: description, total, "Sam paid", the viewer's share ("your share $22.60", or "not yours" when the viewer is not a sharer and did not pay), `ago()`, "edited" when `edited`, and a link to `/bills/<id>`. Empty: "No bills yet." A primary "Add a bill" button at the top.
- Home screen: a primary "Add a bill" button near the balance for e-Transfer houses. Activity feed lines for the three new kinds: "{name} added {description} ({total})", "{name} changed {description}", "{name} deleted {description}".
- Masthead: a "Bills" tab linking to `/bills`, shown for e-Transfer houses.

- [ ] **Step 6: Verify in the browser**

Run: `pnpm db:up && pnpm db:migrate && SIGN_IN=email pnpm dev`

Walk this by hand with two browser profiles and `/dev/outbox` for codes:

1. Sign in by email as two people; create an e-Transfer house and join it by the invite link.
2. Add an equal bill. Both balances and "To square up" change.
3. Add a receipt bill: subtotal 50, total 56.50, own 30 and 20. Preview and saved shares read $33.90 and $22.60.
4. As the other person, edit the first bill, then delete the second. Balances follow; the activity feed shows all four events.
5. On `/dev/inbox` press "settle up now". The remaining bill is read-only; `/settle` shows one debt.
6. Check the add form at phone width.

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

```bash
git add -A && git commit -m "feat: add, edit and delete bills, with a live split preview"
```

---

### Task 7: README and final check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

- Add "Bills" to the rules section in three or four plain lines, including the receipt split.
- Remove "Splitting bills (the Splitwise side) is not built." from Known limits.
- Rewrite "Going live" for the card-free launch: a host and a Postgres database, the production settings from Tasks 1 and 2, an email sender (Gmail by SMTP on a host that allows it, or Resend with a domain), and a five-minute cron calling the tick endpoint. Keep the Stripe and Twilio steps under a "Later" heading.
- Update the test count in "Tests and checks".

- [ ] **Step 2: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && kubectl kustomize k8s/overlays/local > /dev/null && kubectl kustomize k8s/overlays/prod > /dev/null`
Expected: all pass.

- [ ] **Step 3: Production-settings smoke test**

Run the built app with `SIGN_IN=email EMAIL_PROVIDER=fake CARD_HOUSES=off INBOUND_EMAIL_PROVIDER=off` and confirm with `curl -s -o /dev/null -w "%{http_code}"`: `/dev/fake-checkout`, `/dev/inbox` → 404; `POST /api/webhooks/payments` with `x-fake-signature: fake` → 404. Then with `EMAIL_PROVIDER=resend RESEND_API_KEY=x EMAIL_FROM=x@example.com`: `/dev/outbox` → 404.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: bills, email sign-in and the card-free launch"
```
