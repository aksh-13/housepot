/** The operator is whoever runs the payment account and sends the occasional e-Transfer. */
export function isOperator(phone: string): boolean {
  return (process.env.OPERATOR_PHONES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .includes(phone);
}
