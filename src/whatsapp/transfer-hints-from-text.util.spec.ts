import {
  extractTransferHintsFromText,
  looksLikeTransferIntent,
} from './transfer-hints-from-text.util';

describe('extractTransferHintsFromText', () => {
  it('extracts account and bank from a natural transfer message', () => {
    expect(
      extractTransferHintsFromText(
        'i want to send money to this account 8100368023, Opay',
      ),
    ).toEqual({
      accountNumber: '8100368023',
      bankName: 'opay',
    });
  });

  it('extracts amount from send phrasing', () => {
    expect(extractTransferHintsFromText('send 800 to my landlord')).toEqual({
      amount: 800,
      labelHint: 'RENT',
    });
  });

  it('detects transfer intent in natural phrasing', () => {
    expect(
      looksLikeTransferIntent(
        'i want to send money to this account 8100368023, Opay',
      ),
    ).toBe(true);
  });
});
