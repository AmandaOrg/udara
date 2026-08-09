import { Module } from "@nestjs/common";
import { TaggingService } from "./tagging.service";

@Module({
  providers: [TaggingService],
  exports: [TaggingService],
})
export class TaggingModule {}
