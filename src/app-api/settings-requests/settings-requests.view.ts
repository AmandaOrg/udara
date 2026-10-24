import { ApiProperty } from "@nestjs/swagger";
import { SettingsChangeRequest } from "@prisma/client";

export const SETTINGS_REQUEST_TYPES = [
  "window_hours",
  "override_fees",
  "exit_restrictions",
  "other",
  "account_deletion",
] as const;
export const SETTINGS_REQUEST_STATUSES = [
  "pending",
  "eligible_for_review",
  "approved",
  "rejected",
  "withdrawn",
] as const;

export class SettingsRequestView {
  id!: string;
  @ApiProperty({ enum: SETTINGS_REQUEST_TYPES })
  type!: (typeof SETTINGS_REQUEST_TYPES)[number];
  @ApiProperty({ enum: SETTINGS_REQUEST_STATUSES })
  status!: (typeof SETTINGS_REQUEST_STATUSES)[number];
  requestedChange!: string;
  reason!: string | null;
  requestedAt!: string;
  /** Not decided before this, however it is asked. */
  eligibleAt!: string;
  resolvedAt!: string | null;
  /** What the managers said with their decision. */
  managerNotes!: string | null;
}

export class SettingsRequestListView {
  requests!: SettingsRequestView[];
}

export function toSettingsRequestView(
  request: SettingsChangeRequest,
): SettingsRequestView {
  return {
    id: request.id,
    type: request.type.toLowerCase() as SettingsRequestView["type"],
    status: request.status.toLowerCase() as SettingsRequestView["status"],
    requestedChange: request.requestedChange,
    reason: request.reason,
    requestedAt: request.requestedAt.toISOString(),
    eligibleAt: request.eligibleAt.toISOString(),
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    managerNotes: request.managerNotes,
  };
}
