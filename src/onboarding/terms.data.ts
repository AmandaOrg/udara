/**
 * The terms a user consents to before Udara collects anything about them or
 * touches their money.
 *
 * Written as plain consequences rather than legal prose on purpose. Udara's
 * whole proposition is that it will refuse things the user asks for later, at
 * exactly the moment they least want to hear it. Consent to that is only
 * meaningful if the person understood what they were agreeing to at the time,
 * so the summary below leads with the restrictions and the money, not the
 * benefits.
 *
 * TERMS_VERSION is stored on User.termsVersion at consent. Bump it whenever
 * the substance below changes, so re-consent can be required rather than
 * existing users being silently grandfathered onto terms they never saw.
 */
export const TERMS_VERSION = "2026-08-v1";

/** The summary shown in-chat, as separate bubbles. */
export const TERMS_SUMMARY: string[] = [
  "before we go further, here's exactly what you're agreeing to. read it properly, because some of it is designed to be inconvenient.",

  "*your money and who holds it*\nyour account is provided by rubies microfinance bank and regulated by the central bank of nigeria. udara is not a bank and never holds your money. i sit in front of your account and decide what gets through.",

  "*what i will stop you doing*\ntransfers only go out between 11am and 8pm. outside that window they are blocked, and i will not make exceptions in the moment, no matter how you ask. going over your daily limit means answering for it first.",

  "*what it costs you*\nspending outside your window or beyond your limit is possible, but it carries an override fee that is deducted from your account automatically. that fee is the point: it makes the easy thing cost something. fees are non-refundable.",

  "*getting out*\nyou can leave whenever you want, but not instantly. lifting your restrictions goes through a 7 day cooling-off period first. that delay exists so a bad hour can't undo months of work. your money itself is never locked, only the restrictions take time to remove.",

  "*your data*\ni store your name, city, income, goals and transaction history to build and enforce your plan. your bvn or nin is passed straight to rubies for verification and is never stored by udara. i'll email you about money in, money out, and your weekly and monthly summaries.",

  "*being honest with you*\ni'm an ai. i get things wrong sometimes. i am not a licensed financial adviser and nothing i say is regulated financial advice. for anything that matters legally or tax-wise, talk to a professional.",
];

/** The consent question itself, kept separate so it can be re-asked alone. */
export const TERMS_CONSENT_QUESTION =
  "do you agree to these terms and want to continue?";

/** Sent when the user asks what happens if they break the rules. */
export const TERMS_CONSEQUENCES_DETAIL: string[] = [
  "fair question, here's what actually happens.",

  "*if you try to send money outside your window*\nthe transfer is refused. not delayed, refused. you can pay an override fee to force it through, and i'll ask you to confirm that you want to, but i won't pretend it's a good idea.",

  "*if you go over your daily limit*\ni'll tell you what you're about to do and what it costs, then ask you to confirm. if you confirm, it goes through with a borrowing fee and comes out of tomorrow.",

  "*if you ask me to raise your limits*\ni'll talk it through with you. genuine changes go to a review that takes time to clear, deliberately. i will not raise a limit because you asked while you were in a shop.",

  "*if you want out entirely*\nyou file to exit, you wait 7 days, and then restrictions come off. your money is yours the whole time. the wait is on the restrictions, not your funds.",

  "*if you just stop using me*\nnothing bad happens. your account stays, your money stays yours. i'll go quiet other than your summaries.",
];
