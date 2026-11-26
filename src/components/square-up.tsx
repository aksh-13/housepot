import { settleWithAction } from "@/app/actions";
import type { SquareUpLine } from "@/domain/settleup";
import { formatCents } from "@/money";
import { SubmitButton } from "./buttons";

type Props = {
  lines: SquareUpLine[];
  meId: string;
  /** Whether the viewer may act on their own lines (they are an active housemate). */
  canAct: boolean;
};

/**
 * Who would pay whom to square the house up, as rows. On the viewer's own lines there is one
 * button: "Pay" when they owe (it opens the pay card), "Request" when they are owed (it asks the
 * other person to pay). Either one turns just that line into a payment.
 */
export function SquareUpList({ lines, meId, canAct }: Props) {
  return (
    <>
      {lines.map((l) => {
        const iPay = l.fromMemberId === meId;
        const iGet = l.toMemberId === meId;
        return (
          <div key={`${l.fromMemberId}-${l.toMemberId}`} className="row">
            <span>
              {iPay
                ? `You pay ${l.toName}`
                : iGet
                  ? `${l.fromName} pays you`
                  : `${l.fromName} pays ${l.toName}`}
            </span>
            <span className="leader" />
            <span className={`amt ${iPay ? "loss" : iGet ? "gain" : ""}`}>{formatCents(l.amountCents)}</span>
            {canAct && (iPay || iGet) && (
              <form action={settleWithAction} className="row-action">
                <input type="hidden" name="otherMemberId" value={iPay ? l.toMemberId : l.fromMemberId} />
                <SubmitButton className="btn btn-small" pendingLabel="…">
                  {iPay ? "Pay" : "Request"}
                </SubmitButton>
              </form>
            )}
          </div>
        );
      })}
    </>
  );
}
