import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

type State<T> = { data?: T; error?: ApiError; loading: boolean };

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<State<T>>({ loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => setState({ data, loading: false }),
      (error: unknown) => setState({ error: error instanceof ApiError ? error : new ApiError(0, 'error', String(error)), loading: false }),
    );
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload, setData: (data: T) => setState({ data, loading: false }) };
}
