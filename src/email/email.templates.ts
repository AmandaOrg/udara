import { RecipientLabel } from "@prisma/client";

/**
 * Email bodies, built as inline-styled HTML strings.
 *
 * Inline styles and table-free simple markup on purpose: email clients strip
 * <style> blocks, ignore most modern CSS, and Gmail in particular drops
 * anything it doesn't recognise. Nothing here loads an external asset, so the
 * mail renders identically with images blocked.
 *
 * Copy follows Udara's lowercase texting voice from the WhatsApp side, and
 * the same no-em-dash rule.
 */

export const naira = (amount: number): string =>
  `₦${Math.round(amount).toLocaleString("en-NG")}`;

const BRAND = "#1f7a5a";
const INK = "#1c1c1c";
const MUTED = "#6b6b6b";
const RULE = "#e6e6e6";

function layout(heading: string, bodyHtml: string): string {
  return `<div style="margin:0;padding:24px 12px;background:#f6f7f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 24px;">
    <div style="font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${BRAND};">Udara</div>
    <h1 style="margin:14px 0 18px;font-size:20px;line-height:1.35;color:${INK};font-weight:600;">${heading}</h1>
    ${bodyHtml}
    <p style="margin:26px 0 0;padding-top:16px;border-top:1px solid ${RULE};font-size:12px;line-height:1.6;color:${MUTED};">
      you're getting this because you have a Udara account. reply to your Udara chat on WhatsApp if anything here looks wrong.
    </p>
  </div>
</div>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${INK};">${text}</p>`;
}

/** The big number an alert email exists to communicate. */
function amountBlock(amount: number, caption: string): string {
  return `<div style="margin:0 0 18px;padding:16px;background:#f2f7f4;border-radius:10px;">
    <div style="font-size:26px;font-weight:700;color:${BRAND};">${naira(amount)}</div>
    <div style="margin-top:4px;font-size:13px;color:${MUTED};">${caption}</div>
  </div>`;
}

function rows(pairs: [string, string][]): string {
  if (pairs.length === 0) return "";
  const items = pairs
    .map(
      ([label, value]) =>
        `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid ${RULE};font-size:14px;color:${INK};">
          <span style="color:${MUTED};">${label}</span><span style="font-weight:600;">${value}</span>
        </div>`,
    )
    .join("");
  return `<div style="margin:0 0 18px;">${items}</div>`;
}

const firstNameOf = (name: string | null): string =>
  (name ?? "there").split(" ")[0];

export function moneyInEmail(params: {
  name: string | null;
  amount: number;
  balance?: number | null;
  senderName?: string | null;
  receivedAt: Date;
}): { subject: string; html: string } {
  const body = [
    paragraph(
      `hey ${firstNameOf(params.name)}, money just landed in your udara account.`,
    ),
    amountBlock(params.amount, "received"),
    rows(
      [
        params.senderName
          ? (["from", params.senderName] as [string, string])
          : null,
        ["when", params.receivedAt.toLocaleString("en-NG")] as [string, string],
        params.balance != null
          ? (["balance after", naira(params.balance)] as [string, string])
          : null,
      ].filter((r): r is [string, string] => r !== null),
    ),
    paragraph(
      `this counts toward the plan we built together. you can spend it during your window, and i'll flag anything that doesn't fit.`,
    ),
  ].join("");

  return {
    subject: `${naira(params.amount)} received in your Udara account`,
    html: layout("money in", body),
  };
}

export function moneyOutEmail(params: {
  name: string | null;
  amount: number;
  feeAmount: number;
  recipientName: string;
  recipientAccount: string;
  bankName?: string | null;
  sentAt: Date;
}): { subject: string; html: string } {
  const total = params.amount + params.feeAmount;
  const body = [
    paragraph(
      `hey ${firstNameOf(params.name)}, a transfer just went out of your udara account.`,
    ),
    amountBlock(params.amount, "sent"),
    rows(
      [
        ["to", params.recipientName] as [string, string],
        ["account", params.recipientAccount] as [string, string],
        params.bankName
          ? (["bank", params.bankName] as [string, string])
          : null,
        params.feeAmount > 0
          ? (["override fee", naira(params.feeAmount)] as [string, string])
          : null,
        params.feeAmount > 0
          ? (["total debited", naira(total)] as [string, string])
          : null,
        ["when", params.sentAt.toLocaleString("en-NG")] as [string, string],
      ].filter((r): r is [string, string] => r !== null),
    ),
    params.feeAmount > 0
      ? paragraph(
          `this one sat outside your normal plan, so an override fee of ${naira(params.feeAmount)} applied.`,
        )
      : "",
    paragraph(
      `if this wasn't you, message me on WhatsApp straight away and change your pin.`,
    ),
  ].join("");

  return {
    subject: `${naira(params.amount)} sent to ${params.recipientName}`,
    html: layout("money out", body),
  };
}

export function windowOpenEmail(params: {
  name: string | null;
  dailyLimit: number;
  remainingToday: number;
  windowStartHour: number;
  windowEndHour: number;
}): { subject: string; html: string } {
  const body = [
    paragraph(
      `morning ${firstNameOf(params.name)}, your spending window is open.`,
    ),
    amountBlock(params.remainingToday, "available to spend today"),
    rows([
      ["daily limit", naira(params.dailyLimit)],
      [
        "window",
        `${params.windowStartHour}:00 to ${params.windowEndHour}:00 WAT`,
      ],
    ]),
    paragraph(
      `transfers outside that window are locked. inside it, anything over your daily limit we'll talk through first.`,
    ),
  ].join("");

  return {
    subject: "your spending window is open",
    html: layout("window open", body),
  };
}

export interface SummaryEmailData {
  name: string | null;
  periodLabel: string; // "this week" / "January 2026"
  totalSpent: number;
  transactionCount: number;
  byLabel: Partial<Record<RecipientLabel, number>>;
  byDay?: { date: string; amount: number }[];
  allowanceForPeriod?: number | null;
}

function summaryBody(data: SummaryEmailData): string {
  if (data.transactionCount === 0) {
    return [
      paragraph(
        `hey ${firstNameOf(data.name)}, here's your ${data.periodLabel} recap.`,
      ),
      paragraph(
        `you didn't spend anything through udara ${data.periodLabel}. that's either great discipline or spending that went somewhere i can't see. either way, worth knowing.`,
      ),
    ].join("");
  }

  const labelRows = (Object.entries(data.byLabel) as [RecipientLabel, number][])
    .sort((a, b) => b[1] - a[1])
    .map(
      ([label, amount]) =>
        [label.toLowerCase(), naira(amount)] as [string, string],
    );

  const parts = [
    paragraph(
      `hey ${firstNameOf(data.name)}, here's your ${data.periodLabel} recap.`,
    ),
    amountBlock(
      data.totalSpent,
      `across ${data.transactionCount} transaction${data.transactionCount === 1 ? "" : "s"}`,
    ),
  ];

  if (data.allowanceForPeriod != null && data.allowanceForPeriod > 0) {
    const pct = Math.round((data.totalSpent / data.allowanceForPeriod) * 100);
    parts.push(
      rows([
        ["allowance for the period", naira(data.allowanceForPeriod)],
        ["used", `${pct}%`],
      ]),
    );
    parts.push(
      paragraph(
        pct > 100
          ? `you went over by ${naira(data.totalSpent - data.allowanceForPeriod)}. worth a look at what pushed it.`
          : `you stayed inside your allowance, with ${naira(data.allowanceForPeriod - data.totalSpent)} to spare.`,
      ),
    );
  }

  if (labelRows.length > 0) {
    parts.push(
      `<div style="margin:18px 0 8px;font-size:13px;font-weight:600;color:${MUTED};text-transform:uppercase;letter-spacing:.08em;">where it went</div>`,
      rows(labelRows),
    );
  }

  if (data.byDay && data.byDay.length > 0) {
    parts.push(
      `<div style="margin:18px 0 8px;font-size:13px;font-weight:600;color:${MUTED};text-transform:uppercase;letter-spacing:.08em;">by day</div>`,
      rows(
        data.byDay.map((d) => [d.date, naira(d.amount)] as [string, string]),
      ),
    );
  }

  return parts.join("");
}

export function weeklySummaryEmail(data: SummaryEmailData): {
  subject: string;
  html: string;
} {
  return {
    subject: `your week with Udara: ${naira(data.totalSpent)} spent`,
    html: layout("your week", summaryBody(data)),
  };
}

export function monthlySummaryEmail(data: SummaryEmailData): {
  subject: string;
  html: string;
} {
  return {
    subject: `${data.periodLabel} with Udara: ${naira(data.totalSpent)} spent`,
    html: layout(`${data.periodLabel}`, summaryBody(data)),
  };
}

export function pinResetOtpEmail(params: {
  name: string | null;
  otp: string;
  expiresInMinutes: number;
}): { subject: string; html: string } {
  const body = [
    paragraph(
      `hey ${firstNameOf(params.name)}, here's the code to reset your udara transfer pin.`,
    ),
    `<div style="margin:0 0 18px;padding:18px;background:#f2f7f4;border-radius:10px;text-align:center;">
      <div style="font-size:32px;font-weight:700;letter-spacing:.22em;color:${BRAND};">${params.otp}</div>
      <div style="margin-top:6px;font-size:13px;color:${MUTED};">expires in ${params.expiresInMinutes} minutes</div>
    </div>`,
    paragraph(
      `enter it in the form i sent you on WhatsApp, along with your new pin.`,
    ),
    paragraph(
      `<strong>if you didn't ask to reset your pin, someone else may have your phone.</strong> ignore this email, your pin stays exactly as it is, and nothing changes without this code.`,
    ),
    paragraph(
      `udara will never ask you for this code in chat, and no one from udara will ever ask you for it.`,
    ),
  ].join("");

  return {
    subject: `${params.otp} is your Udara PIN reset code`,
    html: layout("reset your pin", body),
  };
}
