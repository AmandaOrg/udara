import { parseToolCallArguments } from './parse-tool-arguments.util';

describe('parseToolCallArguments', () => {
  it('returns objects as-is', () => {
    expect(parseToolCallArguments({ message: 'hi' })).toEqual({
      message: 'hi',
    });
  });

  it('parses a JSON string', () => {
    expect(
      parseToolCallArguments('{"message":"on it","action":{"type":"reply_only"}}'),
    ).toEqual({
      message: 'on it',
      action: { type: 'reply_only' },
    });
  });

  it('returns undefined on truncated JSON instead of throwing', () => {
    expect(
      parseToolCallArguments('{"message":"this is a long rant that got cut'),
    ).toBeUndefined();
  });
});
