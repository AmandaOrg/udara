import { hasActionableTransferHints, sanitizeTransferHints } from './transfer-hints.util';

describe('sanitizeTransferHints', () => {
  it('keeps valid fields and drops invalid ones', () => {
    expect(
      sanitizeTransferHints({
        amount: 5000,
        account_number: '0123-456-789',
        bank_name: 'GTBank',
        bank_code: '000013',
        label_hint: 'RENT',
        garbage: true,
      }),
    ).toEqual({
      amount: 5000,
      accountNumber: '0123456789',
      bankName: 'GTBank',
      bankCode: '000013',
      labelHint: 'RENT',
    });
  });

  it('rejects non-10-digit account numbers', () => {
    expect(
      sanitizeTransferHints({ account_number: '12345' }).accountNumber,
    ).toBeUndefined();
  });

  it('rejects invalid label hints', () => {
    expect(
      sanitizeTransferHints({ label_hint: 'GAMBLING' }).labelHint,
    ).toBeUndefined();
  });

  it('returns empty object for missing input', () => {
    expect(sanitizeTransferHints()).toEqual({});
    expect(sanitizeTransferHints({})).toEqual({});
  });
});

describe('hasActionableTransferHints', () => {
  it('is true when amount and destination are present', () => {
    expect(
      hasActionableTransferHints({
        amount: 200,
        accountNumber: '8100368023',
        bankName: 'opay',
      }),
    ).toBe(true);
  });

  it('is false for amount only', () => {
    expect(hasActionableTransferHints({ amount: 200 })).toBe(false);
  });
});
