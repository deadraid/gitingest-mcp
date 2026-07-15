export function isValidNamedGitReference(reference: string): boolean {
  if (
    reference === '@' ||
    reference.startsWith('-') ||
    reference.startsWith('/') ||
    reference.endsWith('/') ||
    reference.endsWith('.') ||
    reference.includes('..') ||
    reference.includes('//') ||
    reference.includes('@{')
  ) {
    return false;
  }

  for (const character of reference) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      '~^:?*[\\'.includes(character)
    ) {
      return false;
    }
  }

  return reference
    .split('/')
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith('.') &&
        !component.toLowerCase().endsWith('.lock')
    );
}

export function isValidGitCommit(reference: string): boolean {
  if (reference.length < 4 || reference.length > 64) return false;

  for (const character of reference) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isDigit = codePoint >= 0x30 && codePoint <= 0x39;
    const isLowerHex = codePoint >= 0x61 && codePoint <= 0x66;
    const isUpperHex = codePoint >= 0x41 && codePoint <= 0x46;
    if (!isDigit && !isLowerHex && !isUpperHex) return false;
  }

  return true;
}
