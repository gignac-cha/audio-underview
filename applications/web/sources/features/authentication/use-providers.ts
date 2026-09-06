import { oauthProviderIDSchema } from '@audio-underview/schemas';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { useApiClient } from '../../api/use-api-client.tsx';

const providersResponseSchema = z.object({
  providers: z.array(oauthProviderIDSchema),
});

/** `GET {AUTH}/providers` — 활성화된 provider 목록 (공개, 인증 불필요). */
export const useEnabledProviders = () => {
  const client = useApiClient();

  const query = useQuery({
    queryKey: ['authentication', 'providers'],
    queryFn: async () => {
      const response = await client.request('VITE_AUTHENTICATION_WORKER_URL', '/providers', {
        authenticated: false,
        schema: providersResponseSchema,
      });
      return response.providers;
    },
    staleTime: Infinity,
  });

  return {
    providers: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
};
