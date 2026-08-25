import { expect } from 'expect';
import type { HttpResponse } from './http';

export { expect };

export function expectStatus(
  res: HttpResponse<unknown>,
  expected: number,
): void {
  if (res.status !== expected) {
    const preview = (res.text ?? JSON.stringify(res.body)).slice(0, 500);
    throw new Error(
      `expected HTTP ${expected}, got ${res.status}\nbody: ${preview}`,
    );
  }
}

export function expectContains(haystack: string, needle: string): void {
  if (!haystack.toLowerCase().includes(needle.toLowerCase())) {
    throw new Error(
      `expected text to contain ${JSON.stringify(needle)}, got ${JSON.stringify(haystack.slice(0, 300))}`,
    );
  }
}
