export class BankView {
  code!: string;
  name!: string;
}

export class BanksView {
  /** Sorted by name. */
  banks!: BankView[];
}

export class NameEnquiryView {
  /** The name the bank holds for the account. */
  accountName!: string;
}
