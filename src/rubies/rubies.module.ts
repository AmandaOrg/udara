import { Module } from "@nestjs/common";
import { HttpModule } from "@nestjs/axios";
import { RubiesService } from "./rubies.service";

@Module({
  imports: [HttpModule],
  providers: [RubiesService],
  exports: [RubiesService],
})
export class RubiesModule {}
