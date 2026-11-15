import type { Db } from "@/db";

type LogArgs = { houseId: string; memberId?: string | null; kind: string; data?: object; now: Date };

/** Adds a line to the house's activity feed. */
export async function logActivity(db: Db, a: LogArgs): Promise<void> {
  await db.query(
    "insert into activity (house_id, member_id, kind, data, created_at) values ($1, $2, $3, $4, $5)",
    [a.houseId, a.memberId ?? null, a.kind, JSON.stringify(a.data ?? {}), a.now],
  );
}

export type ActivityItem = {
  id: string;
  kind: string;
  data: Record<string, any>;
  createdAt: Date;
  memberId: string | null;
  memberName: string | null;
};

export async function recentActivity(db: Db, houseId: string, limit = 40): Promise<ActivityItem[]> {
  const { rows } = await db.query<ActivityItem>(
    `select a.id, a.kind, a.data, a.created_at as "createdAt", a.member_id as "memberId", u.name as "memberName"
     from activity a left join members m on m.id = a.member_id left join users u on u.id = m.user_id
     where a.house_id = $1 order by a.created_at desc, a.id desc limit $2`,
    [houseId, limit],
  );
  return rows;
}
