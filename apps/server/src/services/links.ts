export function makeLinks(base: string) {
  return {
    review: (proposalId: string) => `${base}/review/${proposalId}`,
    item: (lotId: string) => `${base}/items/${lotId}`,
    inventory: (params: Record<string, string> = {}) => {
      const q = new URLSearchParams(params).toString();
      return `${base}/inventory${q ? `?${q}` : ''}`;
    },
  };
}
