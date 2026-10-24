export class AcceptedTermsView {
  version!: string | null;
  at!: string;
}

export class TermsView {
  version!: string;
  /** The terms as the chat shows them, one bubble each. */
  summary!: string[];
  consentQuestion!: string;
  /** What the user last agreed to; null for someone still onboarding. */
  accepted!: AcceptedTermsView | null;
  /** Agreed to an earlier version, and must be asked again. */
  needsConsent!: boolean;
}

export class TermsAcceptedView {
  version!: string;
  acceptedAt!: string;
}
