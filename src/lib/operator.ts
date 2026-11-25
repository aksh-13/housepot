const list = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

/** The operator is whoever runs the payment account and sends the occasional e-Transfer. */
export function isOperator(user: { phone: string | null; email: string | null }): boolean {
  if (user.email && list("OPERATOR_EMAILS").includes(user.email.toLowerCase())) return true;
  return Boolean(user.phone && list("OPERATOR_PHONES").includes(user.phone));
}
