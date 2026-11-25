import { expect, test } from "vitest";
import { resendEmail, SEND_TIMEOUT_MS, smtpOptions, subjectFor } from "@/providers/email";

test("subjectFor takes the first sentence", () => {
  expect(subjectFor("Your Housepot code is 123456. It works for 10 minutes.")).toBe(
    "Housepot: Your Housepot code is 123456",
  );
});

test("subjectFor stops at a colon that introduces a link", () => {
  expect(subjectFor("Garbage is yours today, by 9:00 PM. Done or skip: https://housepot.test/house")).toBe(
    "Housepot: Garbage is yours today, by 9:00 PM",
  );
});

test("subjectFor cuts a long first sentence at 60 characters", () => {
  const subject = subjectFor("a".repeat(200));
  expect(subject).toBe(`Housepot: ${"a".repeat(60)}`);
});

const ENV = { RESEND_API_KEY: "k", EMAIL_FROM: "Housepot <hi@housepot.test>" };

test("resendEmail posts to Resend with the key, from, to, subject and text", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  };
  const body = "Your Housepot code is 123456. It works for 10 minutes.";
  await resendEmail(ENV, fakeFetch).send("ana@example.com", body);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.resend.com/emails");
  expect(calls[0].init.method).toBe("POST");
  expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer k");
  expect(JSON.parse(String(calls[0].init.body))).toEqual({
    from: ENV.EMAIL_FROM,
    to: ["ana@example.com"],
    subject: "Housepot: Your Housepot code is 123456",
    text: body,
  });
});

test("resendEmail throws when Resend refuses", async () => {
  const refuse = async () => new Response("domain not verified", { status: 422 });
  await expect(resendEmail(ENV, refuse).send("ana@example.com", "Hello.")).rejects.toThrow(
    /422.*domain not verified/,
  );
});

// A host that blocks SMTP leaves the connection hanging. Without a limit the person asking for a
// sign-in code waits minutes and then sees the host's error page instead of ours.
test("an SMTP send gives up after ten seconds at every stage", () => {
  const options = smtpOptions({
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "465",
    SMTP_USER: "u",
    SMTP_PASS: "p",
    EMAIL_FROM: "x@example.com",
  });
  expect(SEND_TIMEOUT_MS).toBe(10_000);
  expect(options).toMatchObject({
    host: "smtp.example.com",
    port: 465,
    secure: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
  expect(
    smtpOptions({ SMTP_HOST: "h", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASS: "p", EMAIL_FROM: "f" }).secure,
  ).toBe(false);
});

test("a Resend send carries a time limit", async () => {
  let signal: AbortSignal | null | undefined;
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal;
    return new Response("{}", { status: 200 });
  };
  await resendEmail(ENV, fakeFetch).send("ana@example.com", "Hello.");
  expect(signal).toBeInstanceOf(AbortSignal);
});
