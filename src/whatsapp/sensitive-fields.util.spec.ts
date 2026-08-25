import {
  REDACTED,
  extractSensitive,
  redactRawPayload,
  redactSensitive,
} from "./sensitive-fields.util";

describe("sensitive-fields.util", () => {
  describe("redactSensitive", () => {
    it("redacts a PIN at the top level", () => {
      expect(redactSensitive({ pin: "8317", flow_token: "tok" })).toEqual({
        pin: REDACTED,
        flow_token: "tok",
      });
    });

    it("keeps flow_token, which is an opaque handle rather than a secret", () => {
      const out = redactSensitive({ flow_token: "abc-123" }) as Record<
        string,
        unknown
      >;
      expect(out.flow_token).toBe("abc-123");
    });

    it("redacts every sensitive field, including the KYC ones", () => {
      const out = redactSensitive({
        first_name: "Ikechukwu",
        id_number: "12345678901",
        date_of_birth: "1998-04-12",
        pin: "8317",
        pin_confirm: "8317",
        email: "me@example.com",
      }) as Record<string, unknown>;

      expect(out).toEqual({
        first_name: "Ikechukwu",
        id_number: REDACTED,
        date_of_birth: REDACTED,
        pin: REDACTED,
        pin_confirm: REDACTED,
        email: "me@example.com",
      });
    });

    it("reaches sensitive keys nested at any depth", () => {
      const out = redactSensitive({
        a: { b: { c: { pin: "8317", safe: "keep" } } },
      });
      expect(JSON.stringify(out)).not.toContain("8317");
      expect(JSON.stringify(out)).toContain("keep");
    });

    it("reaches sensitive keys inside arrays", () => {
      const out = redactSensitive({
        items: [{ pin: "8317" }, { pin: "9999" }],
      });
      expect(JSON.stringify(out)).not.toContain("8317");
      expect(JSON.stringify(out)).not.toContain("9999");
    });

    it("does not mutate its input, since the caller still needs the plaintext", () => {
      const input = { pin: "8317" };
      redactSensitive(input);
      expect(input.pin).toBe("8317");
    });

    it("passes primitives and null through untouched", () => {
      expect(redactSensitive("hello")).toBe("hello");
      expect(redactSensitive(42)).toBe(42);
      expect(redactSensitive(null)).toBeNull();
    });
  });

  describe("redactRawPayload", () => {
    /**
     * The shape Meta actually sends: the Flow's answers arrive as a
     * JSON-encoded *string*, which is precisely why a structural key-delete
     * misses them and why the historical leak count was higher in rawPayload
     * than in flowResponseJson.
     */
    function metaPayload(responseJson: Record<string, unknown>) {
      return {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      interactive: {
                        type: "nfm_reply",
                        nfm_reply: {
                          name: "flow",
                          body: "Sent",
                          response_json: JSON.stringify(responseJson),
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
    }

    it("redacts a PIN encoded inside the response_json string", () => {
      const out = redactRawPayload(
        metaPayload({ pin: "8317", flow_token: "tok" }),
      );
      expect(JSON.stringify(out)).not.toContain("8317");
    });

    it("redacts a BVN encoded inside the response_json string", () => {
      const out = redactRawPayload(
        metaPayload({ id_number: "12345678901", first_name: "Ikechukwu" }),
      );
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("12345678901");
      // Non-sensitive fields survive, so the payload stays useful for debugging.
      expect(serialized).toContain("Ikechukwu");
    });

    it("leaves response_json a parseable JSON string after redaction", () => {
      const out = redactRawPayload(metaPayload({ pin: "8317", a: 1 })) as any;
      const raw =
        out.entry[0].changes[0].value.messages[0].interactive.nfm_reply
          .response_json;
      expect(typeof raw).toBe("string");
      expect(JSON.parse(raw)).toEqual({ pin: REDACTED, a: 1 });
    });

    it("replaces a malformed response_json wholesale rather than storing it", () => {
      const payload = {
        interactive: { nfm_reply: { response_json: "{not valid json" } },
      };
      const out = redactRawPayload(payload) as any;
      expect(out.interactive.nfm_reply.response_json).toBe(REDACTED);
    });

    it("still redacts structurally-present sensitive keys outside response_json", () => {
      const out = redactRawPayload({ deep: { pin: "8317" } });
      expect(JSON.stringify(out)).not.toContain("8317");
    });
  });

  describe("extractSensitive", () => {
    it("pulls out only the sensitive values that are present", () => {
      expect(
        extractSensitive({ pin: "8317", flow_token: "tok", email: "a@b.c" }),
      ).toEqual({ pin: "8317" });
    });

    it("returns both PIN fields on a setup submission", () => {
      expect(extractSensitive({ pin: "8317", pin_confirm: "8317" })).toEqual({
        pin: "8317",
        pin_confirm: "8317",
      });
    });

    it("omits empty and non-string values, so absent stays distinguishable", () => {
      expect(extractSensitive({ pin: "", id_number: 12345 })).toEqual({});
    });
  });
});
