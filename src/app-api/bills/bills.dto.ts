import { ApiProperty } from "@nestjs/swagger";
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { BillPaymentCategory } from "../../prisma/bill-payment.enums";

export const BILL_CATEGORIES = Object.values(BillPaymentCategory);

/**
 * What to buy, in the catalog's terms (GET /v1/bills/catalog). The server
 * takes every code, label, price and bound from the catalog, never from here.
 */
export class CreateBillDto {
  @ApiProperty({ enum: BILL_CATEGORIES, enumName: "BillPaymentCategory" })
  @IsIn(BILL_CATEGORIES)
  category!: BillPaymentCategory;

  /** The network's or electricity company's billerCode. */
  @Matches(/^[A-Z0-9_]{2,40}$/)
  billerCode!: string;

  /** The data bundle's productCode. Required for DATA; the others may omit it. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_.-]{2,60}$/)
  productCode?: string;

  /** The phone number (airtime, data) or the prepaid meter number (electricity). */
  @IsString()
  @MaxLength(20)
  target!: string;

  /**
   * Naira. Required for airtime and electricity; refused for data, whose
   * bundle sets the price.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  amount?: number;
}

export class AuthorizeBillDto {
  /** The pinToken from the confirm step, or the retryToken after a wrong PIN. */
  @IsString()
  @MaxLength(128)
  pinToken!: string;

  @Matches(/^\d{4}$/)
  pin!: string;
}
