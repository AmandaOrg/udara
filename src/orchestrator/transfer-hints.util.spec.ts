import {
  hasActionableTransferHints,
  isActiveSendUtterance,
  isClosedTransferUtterance,
  sanitizeTransferHints,
  shouldPauseForSpendCheck,
} from './transfer-hints.util';

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

  it('keeps beneficiary_name when long enough', () => {
    expect(
      sanitizeTransferHints({ beneficiary_name: '  james  ' }).beneficiaryName,
    ).toBe('james');
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

  it('is true when amount and beneficiary_name are present', () => {
    expect(
      hasActionableTransferHints({ amount: 5000, beneficiaryName: 'james' }),
    ).toBe(true);
  });
});

describe('isClosedTransferUtterance', () => {
  it('treats thanks as a closed send', () => {
    expect(isClosedTransferUtterance('thank you')).toBe(true);
    expect(isClosedTransferUtterance('thanks')).toBe(true);
  });

  it('treats "you already sent it" as closed, not mid-wizard account replies', () => {
    expect(isClosedTransferUtterance("you've done the transfers already")).toBe(
      true,
    );
    expect(isClosedTransferUtterance('I already sent the account')).toBe(false);
  });
});

describe('isActiveSendUtterance', () => {
  it('is true for a send this turn', () => {
    expect(isActiveSendUtterance('send 800 to opay')).toBe(true);
    expect(
      isActiveSendUtterance('lets make a trasfer of 200 to 8100368023, opay'),
    ).toBe(true);
  });

  it('is false for thanks and short acks', () => {
    expect(isActiveSendUtterance('thank you')).toBe(false);
    expect(isActiveSendUtterance('yes')).toBe(false);
  });
});

describe('shouldPauseForSpendCheck', () => {
  it('pauses a vague send and skips when purpose is already stated', () => {
    expect(
      shouldPauseForSpendCheck('send 800 to opay', {
        amount: 800,
        bankName: 'opay',
      }),
    ).toBe(true);
    expect(
      shouldPauseForSpendCheck('send 5k to my landlord', { amount: 5000 }),
    ).toBe(false);
  });
});
