import { WhatsappMessageType } from "@prisma/client";
import { parseInboundPayload } from "./whatsapp-payload.parser";

function entryWith(value: Record<string, unknown>) {
  return {
    entry: [{ id: "WABA_ID", changes: [{ value, field: "messages" }] }],
  };
}

describe("parseInboundPayload", () => {
  it("parses a plain text message", () => {
    const payload = entryWith({
      messages: [
        {
          id: "wamid.1",
          from: "234801",
          timestamp: "1700000000",
          type: "text",
          text: { body: "hi" },
        },
      ],
    });
    const [result] = parseInboundPayload(payload);
    expect(result).toEqual({
      type: WhatsappMessageType.TEXT,
      waMessageId: "wamid.1",
      from: "234801",
      timestamp: "1700000000",
      text: "hi",
    });
  });

  it("parses an interactive button_reply", () => {
    const payload = entryWith({
      messages: [
        {
          id: "wamid.2",
          from: "234801",
          timestamp: "1700000001",
          type: "interactive",
          interactive: {
            type: "button_reply",
            button_reply: { id: "confirm_transfer:abc", title: "Yes" },
          },
        },
      ],
    });
    const [result] = parseInboundPayload(payload);
    expect(result).toMatchObject({
      type: WhatsappMessageType.BUTTON_REPLY,
      buttonId: "confirm_transfer:abc",
      buttonTitle: "Yes",
    });
  });

  it("parses an interactive list_reply", () => {
    const payload = entryWith({
      messages: [
        {
          id: "wamid.3",
          from: "234801",
          timestamp: "1700000002",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "label:rent", title: "Rent" },
          },
        },
      ],
    });
    const [result] = parseInboundPayload(payload);
    expect(result).toMatchObject({
      type: WhatsappMessageType.LIST_REPLY,
      listId: "label:rent",
      listTitle: "Rent",
    });
  });

  it("parses a legacy quick-reply button message", () => {
    const payload = entryWith({
      messages: [
        {
          id: "wamid.4",
          from: "234801",
          timestamp: "1700000003",
          type: "button",
          button: { text: "Confirm", payload: "confirm_transfer:xyz" },
        },
      ],
    });
    const [result] = parseInboundPayload(payload);
    expect(result).toMatchObject({
      type: WhatsappMessageType.BUTTON_REPLY,
      buttonId: "confirm_transfer:xyz",
      buttonTitle: "Confirm",
    });
  });

  it("parses audio, image, document, and location messages", () => {
    const payload = entryWith({
      messages: [
        {
          id: "wamid.5",
          from: "234801",
          timestamp: "1",
          type: "audio",
          audio: { id: "m1", mime_type: "audio/ogg" },
        },
        {
          id: "wamid.6",
          from: "234801",
          timestamp: "2",
          type: "image",
          image: { id: "m2", mime_type: "image/jpeg", caption: "look" },
        },
        {
          id: "wamid.7",
          from: "234801",
          timestamp: "3",
          type: "document",
          document: {
            id: "m3",
            mime_type: "application/pdf",
            filename: "statement.pdf",
          },
        },
        {
          id: "wamid.8",
          from: "234801",
          timestamp: "4",
          type: "location",
          location: { latitude: 6.5, longitude: 3.4 },
        },
      ],
    });
    const results = parseInboundPayload(payload);
    expect(results).toEqual([
      {
        type: WhatsappMessageType.AUDIO,
        waMessageId: "wamid.5",
        from: "234801",
        timestamp: "1",
        mediaId: "m1",
        mimeType: "audio/ogg",
      },
      {
        type: WhatsappMessageType.IMAGE,
        waMessageId: "wamid.6",
        from: "234801",
        timestamp: "2",
        mediaId: "m2",
        mimeType: "image/jpeg",
        caption: "look",
      },
      {
        type: WhatsappMessageType.DOCUMENT,
        waMessageId: "wamid.7",
        from: "234801",
        timestamp: "3",
        mediaId: "m3",
        mimeType: "application/pdf",
        filename: "statement.pdf",
      },
      {
        type: WhatsappMessageType.LOCATION,
        waMessageId: "wamid.8",
        from: "234801",
        timestamp: "4",
        latitude: 6.5,
        longitude: 3.4,
      },
    ]);
  });

  it("parses status (delivery/read receipt) callbacks", () => {
    const payload = entryWith({
      statuses: [
        {
          id: "wamid.9",
          status: "delivered",
          timestamp: "1700000004",
          recipient_id: "234801",
        },
      ],
    });
    const [result] = parseInboundPayload(payload);
    expect(result).toEqual({
      type: WhatsappMessageType.STATUS,
      waMessageId: "wamid.9",
      status: "delivered",
      recipientId: "234801",
      timestamp: "1700000004",
    });
  });

  it("falls back to UNKNOWN for an unrecognized message type", () => {
    const payload = entryWith({
      messages: [
        { id: "wamid.10", from: "234801", timestamp: "1", type: "sticker" },
      ],
    });
    const [result] = parseInboundPayload(payload);
    expect(result.type).toBe(WhatsappMessageType.UNKNOWN);
  });

  it("flattens multiple entries/changes/messages in one payload", () => {
    const payload = {
      entry: [
        {
          id: "A",
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.11",
                    from: "1",
                    timestamp: "1",
                    type: "text",
                    text: { body: "a" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
        {
          id: "B",
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.12",
                    from: "2",
                    timestamp: "2",
                    type: "text",
                    text: { body: "b" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };
    const results = parseInboundPayload(payload);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.waMessageId)).toEqual(["wamid.11", "wamid.12"]);
  });

  it("returns an empty array for malformed/empty payloads without throwing", () => {
    expect(parseInboundPayload(null)).toEqual([]);
    expect(parseInboundPayload(undefined)).toEqual([]);
    expect(parseInboundPayload({})).toEqual([]);
    expect(parseInboundPayload({ entry: "not-an-array" })).toEqual([]);
    expect(
      parseInboundPayload({ entry: [{ changes: [{ value: {} }] }] }),
    ).toEqual([]);
  });
});
