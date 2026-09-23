/**
 * Build-time guard for the published OpenAPI document: an `example` printed
 * next to an `enum` must be one of that enum's values, otherwise the reference
 * advertises a value the request validators reject.
 *
 * Pure — no I/O. Used by `generate-openapi-schemas.ts` (fails the build) and by
 * `src/server/v2/openapiEnumExamples.spec.ts` (fails the suite).
 */
export const findEnumExampleMismatches = (
  node: unknown,
  path = '',
): string[] => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) {
    return node.flatMap((child, i) =>
      findEnumExampleMismatches(child, `${path}[${i}]`),
    )
  }
  const schema = node as Record<string, unknown>
  const found: string[] = []
  if (
    Array.isArray(schema.enum) &&
    'example' in schema &&
    !schema.enum.includes(schema.example)
  ) {
    found.push(
      `${path}: example ${JSON.stringify(schema.example)} is not one of ${JSON.stringify(schema.enum)}`,
    )
  }
  for (const [key, child] of Object.entries(schema)) {
    found.push(...findEnumExampleMismatches(child, path ? `${path}.${key}` : key))
  }
  return found
}
