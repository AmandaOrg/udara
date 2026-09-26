import { AppMessage, Prisma } from "@prisma/client";

/**
 * One chat message as the app receives it. `kind` decides which of the
 * optional fields is present:
 *
 * - outbound `text`: just `text`
 * - outbound `buttons`: `text` and `buttons`; reply with one button's `id`
 * - outbound `list`: `text` and `list`; reply with one row's `id`
 * - outbound `form_request`: `form`, whose `token` goes back with the form
 * - inbound `text`, `choice`, `form_submission`, `start`: what this user sent,
 *   possibly from another of their devices
 */
export interface AppMessageView {
  id: string;
  seq: string;
  direction: "inbound" | "outbound";
  kind: string;
  text: string | null;
  buttons?: { id: string; title: string }[];
  list?: {
    buttonLabel: string;
    rows: { id: string; title: string; description?: string }[];
  };
  form?: {
    kind: string;
    token?: string;
    headerText?: string;
    bodyText?: string;
    ctaText?: string;
  };
  choice?: { messageId: string; id: string };
  createdAt: string;
}

export function toView(row: AppMessage): AppMessageView {
  const payload = asRecord(row.payload);
  const view: AppMessageView = {
    id: row.id,
    seq: row.seq.toString(),
    direction: row.direction === "INBOUND" ? "inbound" : "outbound",
    kind: row.kind.toLowerCase(),
    text: row.body,
    createdAt: row.createdAt.toISOString(),
  };

  switch (row.kind) {
    case "BUTTONS":
      view.buttons = payload.buttons as AppMessageView["buttons"];
      break;
    case "LIST":
      view.list = {
        buttonLabel: String(payload.buttonLabel ?? ""),
        rows: (payload.rows ?? []) as NonNullable<
          AppMessageView["list"]
        >["rows"],
      };
      break;
    case "FORM_REQUEST":
      view.form = {
        kind: String(payload.form ?? ""),
        token: String(payload.token ?? ""),
        headerText: String(payload.headerText ?? ""),
        bodyText: String(payload.bodyText ?? ""),
        ctaText: String(payload.ctaText ?? ""),
      };
      break;
    case "FORM_SUBMISSION":
      view.form = { kind: String(payload.form ?? "") };
      break;
    case "CHOICE":
      view.choice = {
        messageId: String(payload.replyTo ?? ""),
        id: String(payload.choiceId ?? ""),
      };
      break;
    default:
      break;
  }
  return view;
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
