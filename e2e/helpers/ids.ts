/** Unique WhatsApp numbers per scenario run — avoids collisions across parallel-ish runs. */

let seq = 0;

export function uniqueWaNumber(prefix = '234809'): string {
  seq += 1;
  const suffix = `${Date.now().toString().slice(-7)}${seq.toString().padStart(2, '0')}`;
  // Keep roughly phone-like length; Meta payloads use digits only.
  return `${prefix}${suffix}`.slice(0, 15);
}

export function uniqueWamid(label = 'e2e'): string {
  seq += 1;
  return `wamid.${label}.${Date.now()}.${seq}`;
}
