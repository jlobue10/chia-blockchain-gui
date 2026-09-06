import type Metadata from '../@types/Metadata';

export const INVALID_METADATA_ERROR = 'Invalid metadata';

// The longest URL the structural validator accepts; a longer one could
// never be fetched, so it is dropped here rather than carried around.
const MAX_URI_LENGTH = 2084;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Numbers and booleans are common where the spec says string (an attribute
// value of 7, a "sensitive_content" of true); they read the same once shown.
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function asUris(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(
    (uri): uri is string => typeof uri === 'string' && uri.length > 0 && uri.length <= MAX_URI_LENGTH,
  );
}

function asAttributes(value: unknown): { trait_type: string; value: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const attributes: { trait_type: string; value: string }[] = [];
  value.forEach((entry) => {
    if (!isPlainObject(entry)) {
      return;
    }
    const traitType = asText(entry.trait_type);
    const traitValue = asText(entry.value);
    if (traitType !== undefined && traitValue !== undefined) {
      attributes.push({ trait_type: traitType, value: traitValue });
    }
  });
  return attributes;
}

function withoutUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

/** The shape the rest of the GUI may rely on, from whatever a metadata file
 * held. Metadata is minter-authored: a field that is not what the schema says
 * — a URI list that is an object, a hash that is a number, a description that
 * is a nested document — is dropped or coerced here, once, so that no caller
 * has to defend against it, and no tile can take the gallery down by calling
 * an array method on something else. Fields outside the schema are kept as
 * they are. Anything but an object at the root is refused. */
export default function normalizeMetadata(parsed: unknown): Metadata {
  if (!isPlainObject(parsed)) {
    throw new Error(INVALID_METADATA_ERROR);
  }

  const collection = isPlainObject(parsed.collection)
    ? withoutUndefined({
        ...parsed.collection,
        name: asText(parsed.collection.name),
        id: asText(parsed.collection.id),
        attributes: asAttributes(parsed.collection.attributes),
      })
    : undefined;

  const sensitiveContent = parsed.sensitive_content;
  const sensitive =
    typeof sensitiveContent === 'boolean' || sensitiveContent === 'true' || sensitiveContent === 'false'
      ? sensitiveContent
      : undefined;

  return withoutUndefined({
    ...parsed,
    name: asText(parsed.name),
    description: asText(parsed.description),
    image: asString(parsed.image),
    format: asString(parsed.format),
    minting_tool: asText(parsed.minting_tool),
    sensitive_content: sensitive,
    attributes: asAttributes(parsed.attributes),
    collection,
    preview_video_uris: asUris(parsed.preview_video_uris),
    preview_video_hash: asString(parsed.preview_video_hash),
    preview_image_uris: asUris(parsed.preview_image_uris),
    preview_image_hash: asString(parsed.preview_image_hash),
  }) as Metadata;
}
