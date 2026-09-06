import debug from 'debug';
import { useCallback } from 'react';

import type { CacheRequestOptions } from '../@types/CacheService';
import type Metadata from '../@types/Metadata';
import compareChecksums from '../util/compareChecksums';
import { CHECKSUM_MISMATCH_ERROR, METADATA_URI_BUDGET_MS } from '../util/fetchMetadataFromUris';
import parseFileContent from '../util/parseFileContent';

import useCache from './useCache';

const log = debug('chia-gui:useFetchAndProcessMetadata');

export default function useFetchAndProcessMetadata() {
  const { getContentWithInfo } = useCache();

  // One request supplies a consistent set of bytes, checksum and headers.
  // Direct single-URI callers also receive a metadata-sized transfer limit.
  const fetchAndProcessMetadata = useCallback(
    async (uri: string, hash: string | undefined, options?: CacheRequestOptions) => {
      log(`Fetching metadata from ${uri}`);
      const { checksum, headers, content } = await getContentWithInfo(uri, {
        ...options,
        maxDuration: options?.maxDuration ?? METADATA_URI_BUDGET_MS,
      });

      log(`Comparing checksums ${checksum} and ${hash}`);
      if (hash && !compareChecksums(checksum, hash)) {
        throw new Error(CHECKSUM_MISMATCH_ERROR);
      }

      const metadataString = parseFileContent(content, headers);
      return JSON.parse(metadataString) as Metadata;
    },
    [getContentWithInfo /* immutable */],
  );

  return fetchAndProcessMetadata;
}
