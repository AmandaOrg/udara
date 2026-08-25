import { ScenarioOutcome } from './execute';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

function color(useColor: boolean, code: string, text: string): string {
  return useColor ? `${code}${text}${RESET}` : text;
}

export function printTextReport(
  outcomes: ScenarioOutcome[],
  opts: { useColor?: boolean } = {},
): void {
  const useColor = opts.useColor ?? process.stdout.isTTY;
  const pass = outcomes.filter((o) => o.status === 'pass');
  const fail = outcomes.filter((o) => o.status === 'fail');
  const skip = outcomes.filter((o) => o.status === 'skip');

  for (const o of outcomes) {
    if (o.status === 'pass') {
      const ms = `${o.durationMs}ms`;
      console.log(
        `  ${color(useColor, GREEN, 'PASS')}  ${o.name} ${color(
          useColor,
          DIM,
          `(${ms})`,
        )}  ${color(useColor, DIM, '— ' + o.description)}`,
      );
    } else if (o.status === 'skip') {
      console.log(
        `  ${color(useColor, YELLOW, 'SKIP')}  ${o.name}  ${color(
          useColor,
          DIM,
          '— ' + o.reason,
        )}`,
      );
    } else {
      console.log(
        `  ${color(useColor, RED, 'FAIL')}  ${o.name}  ${color(
          useColor,
          DIM,
          '— ' + o.description,
        )}`,
      );
      for (const line of o.error.message.split('\n')) {
        console.log(`        ${color(useColor, RED, line)}`);
      }
      if (o.logs.length) {
        console.log(`        ${color(useColor, DIM, 'logs:')}`);
        for (const l of o.logs) {
          console.log(`          ${color(useColor, DIM, '· ' + l)}`);
        }
      }
    }
  }
  console.log('');
  console.log(
    `Scenarios: ${color(useColor, GREEN, `${pass.length} passed`)}, ${color(
      useColor,
      RED,
      `${fail.length} failed`,
    )}, ${color(useColor, YELLOW, `${skip.length} skipped`)}, ${
      outcomes.length
    } total`,
  );
}

export function printJsonReport(outcomes: ScenarioOutcome[]): void {
  const pass = outcomes.filter((o) => o.status === 'pass').length;
  const fail = outcomes.filter((o) => o.status === 'fail').length;
  const skip = outcomes.filter((o) => o.status === 'skip').length;
  console.log(
    JSON.stringify(
      {
        summary: { pass, fail, skip, total: outcomes.length },
        scenarios: outcomes,
      },
      null,
      2,
    ),
  );
}
