export class BalanceView {
  /** Naira, live from the bank. */
  balance!: number;
}

export class WindowView {
  /** WAT hour the spending window opens. */
  startHour!: number;
  /** WAT hour it closes. */
  endHour!: number;
  open!: boolean;
  /** Null while open, or when restrictions are off. */
  opensInHours!: number | null;
}

export class LimitsView {
  remainingToday!: number;
  remainingWeek!: number;
  /** The managers approved an exit: no window and no override fees. */
  restrictionsOff!: boolean;
  window!: WindowView;
}

export class AccountView {
  accountNumber!: string;
  accountName!: string | null;
  bankName!: string;
  bankCode!: string;
}
