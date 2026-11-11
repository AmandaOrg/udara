import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import type { AppPrincipal } from "../../app-auth/session.service";
import { CurrentPrincipal } from "../current-principal.decorator";
import { CreatePlanDto, QuickSaveDto, UpdatePlanDto, WithdrawDto } from "./savings.dto";
import { SavingsService } from "./savings.service";
import {
  SavingsActionResultView,
  SavingsActivityDetailView,
  SavingsActivityView,
  SavingsBucketDetailView,
  SavingsOverviewView,
  SavingsPlanView,
} from "./savings.view";

@Controller("v1/savings")
export class SavingsController {
  constructor(private readonly savings: SavingsService) {}

  @Get()
  overview(@CurrentPrincipal() principal: AppPrincipal): Promise<SavingsOverviewView> {
    return this.savings.getOverview(principal.userId);
  }

  @Get("activity")
  activities(
    @CurrentPrincipal() principal: AppPrincipal,
    @Query("bucket") bucket?: string,
    @Query("limit") limit?: string,
  ): Promise<SavingsActivityView[]> {
    return this.savings.getActivities(
      principal.userId,
      bucket,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get("activity/:id")
  activityDetail(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id") id: string,
  ): Promise<SavingsActivityDetailView> {
    return this.savings.getActivityDetail(principal.userId, id);
  }

  @Get(":bucket")
  bucketDetail(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("bucket") bucket: string,
  ): Promise<SavingsBucketDetailView> {
    return this.savings.getBucketDetail(principal.userId, bucket);
  }

  @Post("save")
  save(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: QuickSaveDto,
  ): Promise<SavingsActionResultView> {
    return this.savings.save(principal.userId, dto);
  }

  @Post("withdraw")
  withdraw(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: WithdrawDto,
  ): Promise<SavingsActionResultView> {
    return this.savings.withdraw(principal.userId, dto);
  }

  @Post("plans")
  createPlan(
    @CurrentPrincipal() principal: AppPrincipal,
    @Body() dto: CreatePlanDto,
  ): Promise<SavingsPlanView> {
    return this.savings.createPlan(principal.userId, dto);
  }

  @Patch("plans/:id")
  updatePlan(
    @CurrentPrincipal() principal: AppPrincipal,
    @Param("id") id: string,
    @Body() dto: UpdatePlanDto,
  ): Promise<SavingsPlanView> {
    return this.savings.updatePlan(principal.userId, id, dto);
  }
}
