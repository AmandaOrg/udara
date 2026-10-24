export class EmailCodeSentView {
  /** The address, masked: enough to know which inbox to check. */
  sentTo!: string;
  expiresAt!: string;
  resendAfter!: string;
}

export class EmailVerifiedView {
  /** Always true: a code that does not verify is an error response instead. */
  verified!: boolean;
}
