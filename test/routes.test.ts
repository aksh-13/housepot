import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";

process.env.PHOTO_DIR = mkdtempSync(path.join(tmpdir(), "housepot-routes-"));
process.env.TICK_SECRET = "test-tick-secret";

import { GET as healthz } from "@/app/api/healthz/route";
import { POST as tickRoute } from "@/app/api/internal/tick/route";
import { GET as photoRoute } from "@/app/api/photos/[id]/route";
import { GET as readyz } from "@/app/api/readyz/route";
import { POST as webhook } from "@/app/api/webhooks/payments/route";
import { requestCode, verifyCode } from "@/domain/auth";
import { createChore, ensureTurns } from "@/domain/chores";
import { activeMembers, createHouse } from "@/domain/houses";
import { memberBalance } from "@/domain/ledger";
import { savePhoto } from "@/domain/photos";
import { claimBounty, markDone, missTurn } from "@/domain/turns";
import { disputableTurnIds, houseTurns } from "@/domain/views";
import { ago, dueLabel } from "@/lib/format";
import { SESSION_COOKIE } from "@/lib/session";
import { getProviders } from "@/providers";
import { fakeSms } from "@/providers/sms";
import { db, makeHouse, makeUser, resetDb } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z");
const LATE = new Date("2026-11-13T02:00:01Z");

beforeEach(resetDb);

/** Signs the user in for real and returns a Cookie header value. */
async function cookieFor(userId: string): Promise<string> {
  const { rows } = await db.query("select phone from users where id = $1", [userId]);
  await requestCode(db, fakeSms(db), rows[0].phone, new Date());
  const sent = await db.query("select body from sms_outbox order by id desc limit 1");
  const code = sent.rows[0].body.match(/\b(\d{6})\b/)[1];
  const session = await verifyCode(db, rows[0].phone, code, new Date());
  return `${SESSION_COOKIE}=${session!.sessionToken}`;
}

test("healthz answers ok without touching the database", async () => {
  const res = await healthz();
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("readyz answers ok when the database is reachable", async () => {
  expect((await readyz()).status).toBe(200);
});

test("the tick endpoint refuses callers without the secret", async () => {
  const none = await tickRoute(new Request("http://x/api/internal/tick", { method: "POST" }));
  const wrong = await tickRoute(
    new Request("http://x/api/internal/tick", { method: "POST", headers: { authorization: "Bearer nope" } }),
  );
  expect(none.status).toBe(401);
  expect(wrong.status).toBe(401);
});

test("the tick endpoint runs a tick for callers with the secret", async () => {
  const house = await makeHouse(2);
  await createChore(db, {
    houseId: house.houseId,
    memberId: house.members[0].memberId,
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    now: NOW,
  });
  const res = await tickRoute(
    new Request("http://x/api/internal/tick", {
      method: "POST",
      headers: { authorization: "Bearer test-tick-secret" },
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ turnsCreated: 1, errors: 0 });
});

test("a genuine payment webhook credits the member and makes them active", async () => {
  const userId = await makeUser("Ana");
  const h = await createHouse(db, { userId, houseName: "12 Elm", now: NOW });
  if (!h.ok) throw new Error(h.error);
  const body = JSON.stringify({
    type: "payment_succeeded",
    providerRef: "pay_w1",
    memberId: h.memberId,
    amountCents: 2000,
    feeCents: 91,
    purpose: "deposit",
  });
  const res = await webhook(
    new Request("http://x/api/webhooks/payments", {
      method: "POST",
      body,
      headers: { "x-fake-signature": "fake" },
    }),
  );
  expect(res.status).toBe(200);
  expect(await memberBalance(db, h.memberId)).toBe(2000);
  expect((await activeMembers(db, h.houseId)).map((m) => m.id)).toEqual([h.memberId]);
});

test("a webhook without a valid signature is rejected and credits nothing", async () => {
  const userId = await makeUser("Ana");
  const h = await createHouse(db, { userId, houseName: "12 Elm", now: NOW });
  if (!h.ok) throw new Error(h.error);
  const body = JSON.stringify({
    type: "payment_succeeded",
    providerRef: "pay_w2",
    memberId: h.memberId,
    amountCents: 2000,
    feeCents: 91,
    purpose: "deposit",
  });
  const res = await webhook(new Request("http://x/api/webhooks/payments", { method: "POST", body }));
  expect(res.status).toBe(400);
  expect(await memberBalance(db, h.memberId)).toBe(0);
});

test("a proof photo is served to housemates and to nobody else", async () => {
  const house = await makeHouse(2);
  const other = await makeHouse(1);
  const saved = await savePhoto(db, getProviders().storage, {
    houseId: house.houseId,
    memberId: house.members[0].memberId,
    bytes: Buffer.from([9, 8, 7]),
    contentType: "image/png",
    now: NOW,
  });
  if (!saved.ok) throw new Error(saved.error);
  const url = `http://x/api/photos/${saved.photoId}`;
  const ctx = { params: Promise.resolve({ id: saved.photoId }) };

  const mate = await photoRoute(
    new Request(url, { headers: { cookie: await cookieFor(house.members[1].userId) } }),
    ctx,
  );
  expect(mate.status).toBe(200);
  expect(mate.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await mate.arrayBuffer())).toEqual(Buffer.from([9, 8, 7]));

  const outsider = await photoRoute(
    new Request(url, { headers: { cookie: await cookieFor(other.members[0].userId) } }),
    ctx,
  );
  expect(outsider.status).toBe(404);
  expect((await photoRoute(new Request(url), ctx)).status).toBe(404);
  const bad = await photoRoute(
    new Request("http://x/api/photos/not-a-uuid", {
      headers: { cookie: await cookieFor(house.members[1].userId) },
    }),
    {
      params: Promise.resolve({ id: "not-a-uuid" }),
    },
  );
  expect(bad.status).toBe(404);
});

test("houseTurns lists waiting and open turns with who, when and how much is on them", async () => {
  const house = await makeHouse(2);
  const [a, b] = house.members.map((m) => m.memberId);
  const chore = await createChore(db, {
    houseId: house.houseId,
    memberId: a,
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    now: NOW,
  });
  if (!chore.ok) throw new Error(chore.error);
  await ensureTurns(db, house.houseId, NOW);
  const first = (await db.query("select id from turns")).rows[0].id;
  await missTurn(db, { turnId: first, now: LATE });
  await ensureTurns(db, house.houseId, LATE);

  expect(await houseTurns(db, house.houseId)).toEqual([
    {
      id: first,
      choreId: chore.choreId,
      choreName: "Garbage",
      assigneeMemberId: a,
      assigneeName: "Ana",
      dueAt: new Date("2026-11-13T02:00:00Z"),
      status: "open",
      openedReason: "miss",
      skipPriceCents: 500,
      bountyCents: 500,
    },
    {
      id: expect.any(String),
      choreId: chore.choreId,
      choreName: "Garbage",
      assigneeMemberId: b,
      assigneeName: "Ben",
      dueAt: new Date("2026-11-20T02:00:00Z"),
      status: "assigned",
      openedReason: null,
      skipPriceCents: 500,
      bountyCents: 500,
    },
  ]);
});

test("a finished chore can be disputed by the others for 24 hours, once", async () => {
  const house = await makeHouse(3);
  const [a, b] = house.members.map((m) => m.memberId);
  const chore = await createChore(db, {
    houseId: house.houseId,
    memberId: a,
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    now: NOW,
  });
  if (!chore.ok) throw new Error(chore.error);
  await ensureTurns(db, house.houseId, NOW);
  const turnId = (await db.query("select id from turns")).rows[0].id;
  const p = await savePhoto(db, getProviders().storage, {
    houseId: house.houseId,
    memberId: a,
    bytes: Buffer.from([1]),
    contentType: "image/jpeg",
    now: NOW,
  });
  if (!p.ok) throw new Error(p.error);
  await markDone(db, { turnId, memberId: a, photoId: p.photoId, now: NOW });

  const in1h = new Date(NOW.getTime() + 3600_000);
  expect([...(await disputableTurnIds(db, house.houseId, b, in1h))]).toEqual([turnId]);
  expect([...(await disputableTurnIds(db, house.houseId, a, in1h))]).toEqual([]); // your own
  const in25h = new Date(NOW.getTime() + 25 * 3600_000);
  expect([...(await disputableTurnIds(db, house.houseId, b, in25h))]).toEqual([]);

  await db.query(
    "insert into disputes (turn_id, house_id, raised_by_member_id, accused_member_id, completion_at) values ($1, $2, $3, $4, $5)",
    [turnId, house.houseId, b, a, NOW],
  );
  expect([...(await disputableTurnIds(db, house.houseId, b, in1h))]).toEqual([]);
  // claimBounty is imported so the claimed path stays type-checked alongside done.
  expect(typeof claimBounty).toBe("function");
});

test.each([
  ["2026-11-13T02:00:00Z", "Today, 9:00 PM"],
  ["2026-11-14T02:00:00Z", "Tomorrow, 9:00 PM"],
  ["2026-11-20T02:00:00Z", "Thu Nov 19, 9:00 PM"],
  ["2026-11-12T02:00:00Z", "Yesterday, 9:00 PM"],
])("a deadline of %s reads as %s on Thursday afternoon in Toronto", (due, label) => {
  const thursday = new Date("2026-11-12T20:00:00Z");
  expect(dueLabel(new Date(due), thursday, "America/Toronto")).toBe(label);
});

test.each([
  [30_000, "just now"],
  [5 * 60_000, "5m ago"],
  [3 * 3600_000, "3h ago"],
  [2 * 86400_000, "2d ago"],
])("%d ms ago reads as %s", (ms, label) => {
  const now = new Date("2026-11-12T20:00:00Z");
  expect(ago(new Date(now.getTime() - ms), now)).toBe(label);
});
