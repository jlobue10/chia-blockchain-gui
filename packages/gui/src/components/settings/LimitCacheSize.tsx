import { AlertDialog, ButtonLoading, Flex, Form, TextField, useOpenDialog } from '@chia-network/core';
import { t, Trans } from '@lingui/macro';
import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';

import useCache from '../../hooks/useCache';

const MB_SIZE = 1024 * 1024;

type FormData = {
  maxCacheSize: number;
};

export default function LimitCacheSize() {
  const openDialog = useOpenDialog();
  const { maxCacheSize, setMaxCacheSize } = useCache();

  const methods = useForm<FormData>({
    defaultValues: {
      maxCacheSize,
    },
  });

  const { reset, setError } = methods;

  useEffect(() => {
    if (maxCacheSize !== undefined) {
      reset({
        maxCacheSize: maxCacheSize / MB_SIZE,
      });
    }
  }, [maxCacheSize, reset]);

  const { isSubmitting } = methods.formState;
  const isLoading = isSubmitting;
  const canSubmit = !isLoading;

  async function handleSubmit(values: FormData) {
    if (isSubmitting) {
      return;
    }

    // An emptied field reads as 0 (Number('') === 0), and zero would not
    // limit the cache but switch eviction off — the main process refuses it,
    // so say so here instead of submitting it.
    const sizeInMiB = Number(values.maxCacheSize);
    if (!Number.isFinite(sizeInMiB) || sizeInMiB <= 0) {
      setError('maxCacheSize', {
        type: 'validate',
        message: t`Enter a cache size limit above 0 MiB`,
      });
      return;
    }

    const newValue = sizeInMiB * MB_SIZE;

    await setMaxCacheSize(newValue);

    await openDialog(
      <AlertDialog>
        <Trans>Successfully updated cache size limit.</Trans>
      </AlertDialog>,
    );
  }

  return (
    <Form methods={methods} onSubmit={handleSubmit} noValidate>
      <Flex gap={2} row>
        <TextField
          label="MiB"
          name="maxCacheSize"
          type="number"
          disabled={!canSubmit}
          size="small"
          InputProps={{
            inputProps: {
              min: 1,
            },
          }}
        />
        <ButtonLoading
          size="small"
          disabled={!canSubmit}
          type="submit"
          loading={!canSubmit}
          variant="outlined"
          color="secondary"
        >
          <Trans>Update</Trans>
        </ButtonLoading>
      </Flex>
    </Form>
  );
}
