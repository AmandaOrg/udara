/**
 * Context passed to every scenario's `run`.
 */
export interface ScenarioContext {
  /** Human-readable progress logging; shows under a failing scenario's output. */
  log: (msg: string) => void;
}

export interface Scenario {
  /**
   * Dotted scenario id. Used for filtering: `npm run e2e transfer` runs every
   * scenario whose name starts with `transfer.`. Convention:
   * `<feature>.<subcase>.<variant>` — e.g. `transfer.wizard.amount-step`.
   */
  name: string;
  /** One-sentence description — shows in output and helps AI agents pick which to run. */
  description: string;
  /**
   * Tags for arbitrary filtering (e.g. `smoke`, `hack`, `flow`, `orchestrator`).
   * `--tag <t>` on the CLI filters scenarios that declare that tag.
   */
  tags?: string[];
  /**
   * Whether to skip. Use for scenarios that need a fixture/flag that isn't
   * provisioned yet — still visible in the scenario list.
   */
  skip?: boolean | { reason: string };
  run: (ctx: ScenarioContext) => Promise<void>;
}

/**
 * Identity function — exists for type inference and for the contract that
 * every scenario file's default export is a `Scenario`.
 */
export function defineScenario(s: Scenario): Scenario {
  return s;
}

/** Soft-skip from inside run() — treated as SKIP, not FAIL. */
export class ScenarioSkipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ScenarioSkipped';
  }
}
