/**
 * Golden-dialogue offline runner shared by CLI `--golden` and unit tests.
 */

import * as fs from "fs";
import * as path from "path";
import { ActionValidatorService } from "../orchestrator/action-validator.service";
import { ProposedTurn } from "../orchestrator/orchestrator.types";
import {
  SURFACE_REGISTRY,
  SurfaceDefinition,
} from "../orchestrator/surface-registry";
import { OnboardingStage } from "@prisma/client";

export interface GoldenCase {
  test_case_id: string;
  history: Array<{ role: string; content: string }>;
  mock_proposal: ProposedTurn;
  eligible_surfaces: string[];
  expected_surface: string | null;
  expected_confidence: "high" | "medium" | null;
  forbidden_surfaces: string[];
}

export interface GoldenCaseResult {
  test_case_id: string;
  passed: boolean;
  expected_surface: string | null;
  actual_surface: string | null;
  detail?: string;
}

export function loadGoldenDialogues(
  fixturesPath = path.join(
    __dirname,
    "..",
    "orchestrator",
    "evals",
    "golden-dialogues.json",
  ),
): GoldenCase[] {
  return JSON.parse(fs.readFileSync(fixturesPath, "utf8")) as GoldenCase[];
}

export function runGoldenCase(
  validator: ActionValidatorService,
  c: GoldenCase,
): GoldenCaseResult {
  const user = {
    id: "cli-user",
    onboardingStage: OnboardingStage.ACCOUNT_CREATED,
    rubiesAccountNumber: "0123456789",
  } as any;

  const eligible: SurfaceDefinition[] = c.eligible_surfaces.map((key) => {
    const fromRegistry = SURFACE_REGISTRY.find((s) => s.key === key);
    return (
      fromRegistry ?? {
        key,
        kind: "text" as const,
        description: key,
        isEligible: () => true,
      }
    );
  });

  const lastUser =
    [...c.history].reverse().find((m) => m.role === "user")?.content ?? "";
  const result = validator.validate(c.mock_proposal, user, eligible, lastUser);
  const actual = result.surfaceKey ?? null;
  const passed = actual === c.expected_surface;

  return {
    test_case_id: c.test_case_id,
    passed,
    expected_surface: c.expected_surface,
    actual_surface: actual,
    detail: passed
      ? undefined
      : `expected ${JSON.stringify(c.expected_surface)}, got ${JSON.stringify(actual)}`,
  };
}

export function runAllGoldenCases(
  validator = new ActionValidatorService(),
  fixturesPath?: string,
): GoldenCaseResult[] {
  return loadGoldenDialogues(fixturesPath).map((c) =>
    runGoldenCase(validator, c),
  );
}
