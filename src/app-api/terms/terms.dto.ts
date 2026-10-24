import { IsString, MaxLength } from "class-validator";

export class AcceptTermsDto {
  /** The version the app showed, so an acceptance never covers unseen terms. */
  @IsString()
  @MaxLength(40)
  version!: string;
}
